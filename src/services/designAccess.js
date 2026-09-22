'use strict';

// Explicit permissions for the product workspace. A new route is private until
// deliberately added here; neither a UI tab nor an /admin prefix grants access.
const DESIGN_ROLES = Object.freeze(['design', 'design_view']);
const ADMIN_ROLES = Object.freeze(['admin', 'superadmin', 'manager']);
const ID = '[a-z0-9_-]+';
const rules = [];
function allow(methods, path) {
  rules.push(Object.freeze({
    methods: Object.freeze(methods.split(' ')),
    path: new RegExp('^' + path + '$', 'i'),
  }));
}

allow('GET', '/api/auth/me');
allow('GET', '/api/admin/catalog/(?:form-options|products)');
allow('GET', '/api/admin/catalog/products/' + ID);
allow('GET', '/api/admin/catalog/products/' + ID + '/color-variants');
allow('POST', '/api/admin/catalog/products');
allow('PUT', '/api/admin/catalog/products/' + ID);
// CSV import also writes stock. Publishing, fiscal summaries, and Meta
// credentials, hard deletion and global AI jobs are deliberately absent.

allow('GET', '/api/admin/categories/tree');
allow('GET', '/api/admin/categories/' + ID + '/products');
allow('POST', '/api/admin/categories');
allow('PUT DELETE', '/api/admin/categories/' + ID);
allow('POST', '/api/admin/categories/' + ID + '/assign-products');

allow('POST', '/api/admin/products/' + ID + '/(?:location|description|classification)');
allow('POST', '/api/admin/products/bulk-location');
allow('GET', '/api/admin/inventory/products');
allow('GET', '/api/stocktake/(?:biped-product-ids|located-product-ids)');
allow('GET', '/api/admin/classification/(?:tree|products|brands|stats)');
allow('PATCH', '/api/admin/classification/' + ID);

allow('GET', '/api/admin/product-images/(?:status|pipeline-status|pending)');
allow('GET', '/api/admin/product-images/(?:search|supplier-meta)/' + ID);
allow('POST', '/api/admin/product-images/(?:select|upload|standardize|video)/' + ID);
allow('DELETE', '/api/admin/product-images/(?:select|video)/' + ID);
allow('GET', '/api/admin/vitrine/(?:slots|candidates)');
allow('PUT', '/api/admin/vitrine/slots');

// The alias /api/labels is the same product-label router.
allow('GET', '/api/(?:admin/)?labels/(?:templates|options|batches)');
allow('GET', '/api/(?:admin/)?labels/batches/' + ID + '(?:/pdf)?');
allow('POST', '/api/(?:admin/)?labels/batches/quick');
allow('POST', '/api/(?:admin/)?labels/batches/' + ID + '/print');
// Do not grant promotion changes, bipe-cadastra, or batch deletion here.

allow('GET', '/api/catalog/(?:products|form-options|brands|categories)');
allow('GET', '/api/catalog/products/' + ID);

function isDesignRole(role) {
  return DESIGN_ROLES.includes(role);
}

function isAdminRole(role) {
  return ADMIN_ROLES.includes(role);
}

function requestPath(originalUrl) {
  if (typeof originalUrl !== 'string') return null;
  const path = originalUrl.split('?')[0];
  // Express accepts optional trailing slashes. Reject encodings, separators,
  // and dot segments rather than interpreting them differently from Express.
  if (!path.startsWith('/api/') || /[%\\#\s]/.test(path) || path.includes('//')
    || /(?:^|\/)\.\.?(?:\/|$)/.test(path)) return null;
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

function isDesignRequestAllowed(req) {
  if (!isDesignRole(req.userRole)) return false;
  const method = String(req.method || '').toUpperCase();
  const effectiveMethod = method === 'HEAD' ? 'GET' : method;
  if (req.userRole === 'design_view' && effectiveMethod !== 'GET') return false;
  const path = requestPath(req.originalUrl);
  // This GET generates documents and updates legacy batch/barcode metadata.
  // A view-only profile may inspect batches but cannot generate a new PDF.
  if (req.userRole === 'design_view' && /\/labels\/batches\/[^/]+\/pdf$/i.test(path || '')) return false;
  return !!path && rules.some(rule => rule.methods.includes(effectiveMethod) && rule.path.test(path));
}

module.exports = {
  DESIGN_ROLES,
  isDesignRole,
  isAdminRole,
  isDesignRequestAllowed,
  requestPath,
};
