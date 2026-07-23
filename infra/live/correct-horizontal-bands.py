"""Real-time horizontal LED-band correction for fixed security cameras.

The camera keeps the original frame sharp. The agent estimates the light
variation for every sensor row and applies only a row-specific exposure gain;
it never mixes neighboring frames, so moving customers do not leave ghosts.
"""

from __future__ import annotations

import argparse
import collections
import copy
import logging
import subprocess
import sys
import threading
import time

import cv2
import numpy as np


LOG = logging.getLogger("teniscash-band-correction")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", help="RTSP/HLS input URL")
    parser.add_argument("--output", help="MediaMTX RTSP publish URL")
    parser.add_argument("--ffmpeg", required=True, help="Path to ffmpeg.exe")
    parser.add_argument("--history-seconds", type=float, default=4.0)
    parser.add_argument("--profile-width", type=int, default=160)
    parser.add_argument("--max-fps", type=float, default=10.0)
    parser.add_argument("--bitrate", default="4M")
    parser.add_argument("--encoder", default="h264_qsv")
    parser.add_argument("--store-prefix", help="Example: loja05")
    parser.add_argument("--camera-count", type=int, default=0)
    parser.add_argument("--max-frames", type=int, default=0, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.camera_count:
        if not args.store_prefix:
            parser.error("--store-prefix is required with --camera-count.")
    elif not args.input or not args.output:
        parser.error("--input and --output are required for a single camera.")
    return args


def estimate_row_profile(frame: np.ndarray, width: int) -> np.ndarray:
    height = frame.shape[0]
    small = cv2.resize(frame, (width, height), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    # Clipping removes the direct LED strips and deep-black merchandise from
    # the estimate. A linear row mean is much faster than sorting pixels and
    # is stable enough because the bands span the entire sensor width.
    return np.clip(gray, 24, 232).mean(axis=1).astype(np.float32)


def smooth_rows(values: np.ndarray, sigma: float) -> np.ndarray:
    return cv2.GaussianBlur(
        values[:, None],
        (1, 0),
        sigmaX=0,
        sigmaY=sigma,
    ).ravel()


def correct_frame(
    frame: np.ndarray,
    current_profile: np.ndarray,
    reference_profile: np.ndarray,
) -> np.ndarray:
    current = smooth_rows(current_profile, 3)
    reference = smooth_rows(reference_profile, 3)
    gain = reference / np.maximum(current, 8)
    gain /= max(float(np.median(gain)), 0.01)
    gain = np.clip(gain, 0.48, 2.35)
    gain = smooth_rows(gain, 3)
    corrected = frame.astype(np.float32) * gain[:, None, None]
    return np.clip(corrected, 0, 255).astype(np.uint8)


def encoder_command(
    ffmpeg: str,
    output: str,
    width: int,
    height: int,
    fps: float,
    bitrate: str,
    encoder: str,
) -> list[str]:
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "warning",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "bgr24",
        "-video_size",
        f"{width}x{height}",
        "-framerate",
        f"{fps:.3f}",
        "-i",
        "pipe:0",
        "-an",
        "-vf",
        "format=nv12",
        "-c:v",
        encoder,
    ]
    if encoder == "h264_qsv":
        command += [
            "-preset",
            "veryfast",
            "-look_ahead",
            "0",
            "-b:v",
            bitrate,
            "-maxrate",
            bitrate,
            "-bufsize",
            "8M",
        ]
    elif encoder == "h264_mf":
        command += [
            "-hw_encoding",
            "1",
            "-scenario",
            "live_streaming",
            "-rate_control",
            "pc_vbr",
            "-b:v",
            bitrate,
            "-maxrate",
            bitrate,
            "-bufsize",
            "8M",
        ]
    else:
        command += [
            "-preset",
            "veryfast",
            "-tune",
            "zerolatency",
            "-b:v",
            bitrate,
            "-maxrate",
            bitrate,
            "-bufsize",
            "8M",
        ]
    command += [
        "-g",
        str(max(15, round(fps * 2))),
        "-bf",
        "0",
        "-f",
        "rtsp",
        "-rtsp_transport",
        "tcp",
        output,
    ]
    return command


class LatestFrameReader:
    """Continuously drains OpenCV's decoder and retains only the newest frame."""

    def __init__(self, capture: cv2.VideoCapture) -> None:
        self.capture = capture
        self.condition = threading.Condition()
        self.frame: np.ndarray | None = None
        self.sequence = 0
        self.error: Exception | None = None
        self.stopping = False
        self.thread = threading.Thread(
            target=self._run,
            name=f"{threading.current_thread().name}-reader",
            daemon=True,
        )

    def start(self) -> None:
        self.thread.start()

    def _run(self) -> None:
        try:
            while not self.stopping:
                ok, frame = self.capture.read()
                if not ok:
                    raise RuntimeError("Input stream stopped.")
                with self.condition:
                    self.frame = frame
                    self.sequence += 1
                    self.condition.notify_all()
        except Exception as exc:
            with self.condition:
                self.error = exc
                self.condition.notify_all()

    def next_frame(self, after_sequence: int, timeout: float = 15) -> tuple[int, np.ndarray]:
        deadline = time.monotonic() + timeout
        with self.condition:
            while self.sequence <= after_sequence and self.error is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("Timed out waiting for the next camera frame.")
                self.condition.wait(remaining)
            if self.error is not None:
                raise self.error
            if self.frame is None:
                raise RuntimeError("Camera returned no frame.")
            return self.sequence, self.frame

    def close(self) -> None:
        self.stopping = True
        self.capture.release()
        with self.condition:
            self.condition.notify_all()
        self.thread.join(timeout=3)


def process_stream(args: argparse.Namespace) -> None:
    capture_parameters = [
        cv2.CAP_PROP_OPEN_TIMEOUT_MSEC,
        15000,
        cv2.CAP_PROP_READ_TIMEOUT_MSEC,
        15000,
    ]
    if hasattr(cv2, "CAP_PROP_N_THREADS"):
        # FFmpeg otherwise creates a large decoder thread pool for every
        # camera. One thread decodes 1080p/15fps comfortably and saves hundreds
        # of megabytes when six cameras run together.
        capture_parameters += [cv2.CAP_PROP_N_THREADS, 1]
    capture = cv2.VideoCapture(args.input, cv2.CAP_FFMPEG, capture_parameters)
    capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    if not capture.isOpened():
        raise RuntimeError(f"Could not open input stream: {args.input}")

    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = float(capture.get(cv2.CAP_PROP_FPS))
    if not 1 <= fps <= 60:
        fps = 15.0
    output_fps = min(fps, max(args.max_fps, 1))
    history_size = max(10, round(output_fps * args.history_seconds))

    encoder = subprocess.Popen(
        encoder_command(
            args.ffmpeg,
            args.output,
            width,
            height,
            output_fps,
            args.bitrate,
            args.encoder,
        ),
        stdin=subprocess.PIPE,
    )
    if encoder.stdin is None:
        raise RuntimeError("FFmpeg encoder pipe was not created.")

    profiles: collections.deque[np.ndarray] = collections.deque(maxlen=history_size)
    profile_sum = np.zeros(height, dtype=np.float64)
    frame_count = 0
    started = time.monotonic()
    LOG.info(
        "Started %sx%s at %.2f fps; calibration window=%s frames",
        width,
        height,
        output_fps,
        history_size,
    )
    reader = LatestFrameReader(capture)
    reader.start()
    frame_sequence = 0
    frame_interval = 1 / output_fps
    next_frame_at = time.monotonic()

    try:
        while True:
            delay = next_frame_at - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            frame_sequence, frame = reader.next_frame(frame_sequence)
            next_frame_at = max(next_frame_at + frame_interval, time.monotonic())
            profile = estimate_row_profile(frame, args.profile_width)
            if len(profiles) == profiles.maxlen:
                profile_sum -= profiles[0]
            profiles.append(profile)
            profile_sum += profile

            if len(profiles) >= max(10, round(output_fps)):
                reference = (profile_sum / len(profiles)).astype(np.float32)
                frame = correct_frame(frame, profile, reference)

            encoder.stdin.write(frame.tobytes())
            frame_count += 1
            if args.max_frames and frame_count >= args.max_frames:
                LOG.info("Test frame limit reached.")
                return
            if encoder.poll() is not None:
                raise RuntimeError(f"FFmpeg encoder exited with code {encoder.returncode}.")
            if frame_count % max(round(output_fps * 30), 1) == 0:
                elapsed = max(time.monotonic() - started, 0.001)
                LOG.info("Processed %s frames (%.2f fps average).", frame_count, frame_count / elapsed)
    finally:
        reader.close()
        try:
            encoder.stdin.close()
        except (BrokenPipeError, OSError):
            pass
        try:
            encoder.wait(timeout=5)
        except subprocess.TimeoutExpired:
            encoder.kill()


def run_forever(args: argparse.Namespace) -> None:
    while True:
        try:
            process_stream(args)
        except KeyboardInterrupt:
            return
        except Exception:
            LOG.exception("Stream failed; retrying in 3 seconds.")
            time.sleep(3)


def main() -> int:
    args = parse_args()
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [%(threadName)s] %(message)s",
    )
    if args.camera_count:
        threads = []
        for camera in range(1, args.camera_count + 1):
            stream_args = copy.copy(args)
            stream_args.input = (
                f"rtsp://127.0.0.1:8554/{args.store_prefix}_camera{camera}"
            )
            stream_args.output = (
                f"rtsp://127.0.0.1:8554/{args.store_prefix}_camera{camera}_fixed"
            )
            thread = threading.Thread(
                target=run_forever,
                args=(stream_args,),
                name=f"camera{camera}",
            )
            thread.start()
            threads.append(thread)
        for thread in threads:
            thread.join()
        return 0

    run_forever(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
