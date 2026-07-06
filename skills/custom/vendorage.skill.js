const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '..', '..', 'vendorage-config.json');

function readConfig() {
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (e) {
    // ignore
  }
  return { apiUrl: null, apiKey: null };
}

function writeConfig(config) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

module.exports = {
  id: 'vendorage',
  name: 'Vendorage Integration',
  enabled: true,

  toolDeclarations: [
    {
      name: 'vendorage_set_config',
      description: 'Configure the Vendorage backend API URL and vendor API key. This can only be done by the owner/admin.',
      parameters: {
        type: 'OBJECT',
        properties: {
          apiUrl: {
            type: 'STRING',
            description: 'The base URL of the Vendorage backend, e.g. http://localhost:3000 or https://vendorage.example.com'
          },
          apiKey: {
            type: 'STRING',
            description: 'The unique vendor API key starting with vnd_'
          }
        },
        required: ['apiUrl', 'apiKey']
      }
    },
    {
      name: 'vendorage_get_profile',
      description: 'Fetch the authenticated vendor\'s profile details (store name, username, WhatsApp JID, product count) from Vendorage.',
      parameters: {
        type: 'OBJECT',
        properties: {}
      }
    },
    {
      name: 'vendorage_list_products',
      description: 'Fetch the list of products from the Vendorage catalog. Useful to search for inventory, check pricing, or answer customer inquiries.',
      parameters: {
        type: 'OBJECT',
        properties: {
          vendorId: {
            type: 'STRING',
            description: 'Optional vendor ID to filter products'
          }
        }
      }
    },
    {
      name: 'vendorage_create_product',
      description: 'Create a new product in the vendor\'s store catalog on Vendorage. Requires configured API key.',
      parameters: {
        type: 'OBJECT',
        properties: {
          name: {
            type: 'STRING',
            description: 'Name of the product'
          },
          price: {
            type: 'NUMBER',
            description: 'Price of the product (positive number)'
          },
          imagePath: {
            type: 'STRING',
            description: 'Optional local file path to the product image'
          }
        },
        required: ['name', 'price']
      }
    },
    {
      name: 'vendorage_update_product',
      description: 'Update an existing product\'s name and/or price in the vendor\'s store catalog on Vendorage.',
      parameters: {
        type: 'OBJECT',
        properties: {
          productId: {
            type: 'STRING',
            description: 'The ID of the product to update'
          },
          name: {
            type: 'STRING',
            description: 'Optional new name for the product'
          },
          price: {
            type: 'NUMBER',
            description: 'Optional new price for the product'
          }
        },
        required: ['productId']
      }
    },
    {
      name: 'vendorage_delete_product',
      description: 'Delete a product from the vendor\'s store catalog on Vendorage.',
      parameters: {
        type: 'OBJECT',
        properties: {
          productId: {
            type: 'STRING',
            description: 'The ID of the product to delete'
          }
        },
        required: ['productId']
      }
    }
  ],

  async handleTool(name, args, ctx) {
    const config = readConfig();

    if (name === 'vendorage_set_config') {
      const { apiUrl, apiKey } = args;
      if (!apiUrl || !apiKey) {
        return { ok: false, error: 'Both apiUrl and apiKey are required.' };
      }
      // Normalize URL (strip trailing slash)
      const normalizedUrl = apiUrl.replace(/\/+$/, '');
      writeConfig({ apiUrl: normalizedUrl, apiKey });
      ctx.appendLog(`[Vendorage Custom Skill] Saved new configuration: apiUrl=${normalizedUrl}`);
      return { ok: true, message: 'Vendorage configuration saved successfully.' };
    }

    // For all other tools, ensure config is present
    if (!config.apiUrl) {
      return {
        ok: false,
        error: 'Vendorage is not configured. Please use vendorage_set_config(apiUrl, apiKey) to set up the connection first.'
      };
    }

    const { apiUrl, apiKey } = config;

    switch (name) {
      case 'vendorage_get_profile': {
        if (!apiKey) {
          return { ok: false, error: 'API key is required for authentication.' };
        }
        try {
          const response = await fetch(`${apiUrl}/api/vendors/me`, {
            method: 'GET',
            headers: {
              'X-API-Key': apiKey,
              'Accept': 'application/json'
            }
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) {
            return {
              ok: false,
              statusCode: response.status,
              error: data.statusMessage || data.message || 'Failed to fetch profile'
            };
          }
          return { ok: true, profile: data };
        } catch (e) {
          ctx.appendLog(`[Vendorage Custom Skill] get_profile error: ${e.message}`);
          return { ok: false, error: e.message };
        }
      }

      case 'vendorage_list_products': {
        try {
          const url = args.vendorId
            ? `${apiUrl}/api/products?vendorId=${encodeURIComponent(args.vendorId)}`
            : `${apiUrl}/api/products`;
          const response = await fetch(url, {
            method: 'GET',
            headers: {
              'Accept': 'application/json'
            }
          });
          const data = await response.json().catch(() => ([]));
          if (!response.ok) {
            return {
              ok: false,
              statusCode: response.status,
              error: data.statusMessage || data.message || 'Failed to list products'
            };
          }
          return { ok: true, products: data };
        } catch (e) {
          ctx.appendLog(`[Vendorage Custom Skill] list_products error: ${e.message}`);
          return { ok: false, error: e.message };
        }
      }

      case 'vendorage_create_product': {
        if (!apiKey) {
          return { ok: false, error: 'API key is required for authentication.' };
        }
        try {
          const formData = new FormData();
          formData.append('name_0', args.name);
          formData.append('price_0', String(args.price));

          let fileBuffer;
          let filename = 'product.png';
          let fileType = 'image/png';

          if (args.imagePath && fs.existsSync(args.imagePath)) {
            fileBuffer = fs.readFileSync(args.imagePath);
            filename = path.basename(args.imagePath);
            if (filename.endsWith('.webp')) {
              fileType = 'image/webp';
            } else if (filename.endsWith('.jpg') || filename.endsWith('.jpeg')) {
              fileType = 'image/jpeg';
            }
          } else {
            // 1x1 transparent PNG fallback to satisfy 'image required' schema constraint
            const base64Png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
            fileBuffer = Buffer.from(base64Png, 'base64');
          }

          const blob = new Blob([fileBuffer], { type: fileType });
          formData.append('image_0', blob, filename);

          const response = await fetch(`${apiUrl}/api/products`, {
            method: 'POST',
            headers: {
              'X-API-Key': apiKey,
              'Accept': 'application/json'
            },
            body: formData
          });

          const data = await response.json().catch(() => ({}));
          if (!response.ok) {
            return {
              ok: false,
              statusCode: response.status,
              error: data.statusMessage || data.message || 'Failed to create product'
            };
          }
          return { ok: true, products: data };
        } catch (e) {
          ctx.appendLog(`[Vendorage Custom Skill] create_product error: ${e.message}`);
          return { ok: false, error: e.message };
        }
      }

      case 'vendorage_update_product': {
        if (!apiKey) {
          return { ok: false, error: 'API key is required for authentication.' };
        }
        if (!args.productId) {
          return { ok: false, error: 'Product ID is required.' };
        }
        try {
          const body = {};
          if (args.name !== undefined) body.name = args.name;
          if (args.price !== undefined) body.price = Number(args.price);

          const response = await fetch(`${apiUrl}/api/products/${encodeURIComponent(args.productId)}`, {
            method: 'PATCH',
            headers: {
              'X-API-Key': apiKey,
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            body: JSON.stringify(body)
          });

          const data = await response.json().catch(() => ({}));
          if (!response.ok) {
            return {
              ok: false,
              statusCode: response.status,
              error: data.statusMessage || data.message || 'Failed to update product'
            };
          }
          return { ok: true, product: data };
        } catch (e) {
          ctx.appendLog(`[Vendorage Custom Skill] update_product error: ${e.message}`);
          return { ok: false, error: e.message };
        }
      }

      case 'vendorage_delete_product': {
        if (!apiKey) {
          return { ok: false, error: 'API key is required for authentication.' };
        }
        if (!args.productId) {
          return { ok: false, error: 'Product ID is required.' };
        }
        try {
          const response = await fetch(`${apiUrl}/api/products/${encodeURIComponent(args.productId)}`, {
            method: 'DELETE',
            headers: {
              'X-API-Key': apiKey,
              'Accept': 'application/json'
            }
          });

          const data = await response.json().catch(() => ({}));
          if (!response.ok) {
            return {
              ok: false,
              statusCode: response.status,
              error: data.statusMessage || data.message || 'Failed to delete product'
            };
          }
          return { ok: true, message: data.message || 'Product deleted successfully.' };
        } catch (e) {
          ctx.appendLog(`[Vendorage Custom Skill] delete_product error: ${e.message}`);
          return { ok: false, error: e.message };
        }
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  }
};
