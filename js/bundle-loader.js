/**
 * Bundle Loader
 * Unpacks bundled assets from manifest and template, decodes them from base64,
 * and renders the application in the DOM.
 */

document.addEventListener('DOMContentLoaded', async function () {
  const loading = document.getElementById('__bundler_loading');

  function setStatus(msg) {
    if (loading) loading.textContent = msg;
  }

  // Error handler that persists across DOM replacements
  window.addEventListener('error', function (e) {
    var p = document.body || document.documentElement;
    var d = document.getElementById('__bundler_err') ||
      p.appendChild(document.createElement('div'));

    d.id = '__bundler_err';
    d.className = '__bundler_err';
    d.textContent =
      (d.textContent ? d.textContent + '\n' : '') +
      '[bundle] ' +
      (e.message || e.type) +
      (e.filename ? ` (${e.filename.slice(0, 60)}:${e.lineno})` : '');
  }, true);

  try {
    // Load manifest and template from script tags
    const manifestEl = document.querySelector('script[type="__bundler/manifest"]');
    const templateEl = document.querySelector('script[type="__bundler/template"]');

    if (!manifestEl || !templateEl) {
      setStatus('Error: missing bundle data');
      console.error(
        '[bundler] Missing script tags',
        { manifestEl: !!manifestEl, templateEl: !!templateEl }
      );
      return;
    }

    const manifest = JSON.parse(manifestEl.textContent);
    let template = JSON.parse(templateEl.textContent);

    // Decode all bundled assets
    const uuids = Object.keys(manifest);
    setStatus(`Unpacking ${uuids.length} assets...`);

    const blobUrls = {};

    await Promise.all(
      uuids.map(async (uuid) => {
        const entry = manifest[uuid];
        try {
          // Decode base64 data
          const binaryStr = atob(entry.data);
          const bytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
          }

          // Decompress if needed
          let finalBytes = bytes;
          if (entry.compressed) {
            if (typeof DecompressionStream !== 'undefined') {
              const ds = new DecompressionStream('gzip');
              const writer = ds.writable.getWriter();
              const reader = ds.readable.getReader();

              writer.write(bytes);
              writer.close();

              const chunks = [];
              let totalLen = 0;

              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                totalLen += value.length;
              }

              finalBytes = new Uint8Array(totalLen);
              let offset = 0;
              for (const chunk of chunks) {
                finalBytes.set(chunk, offset);
                offset += chunk.length;
              }
            } else {
              console.warn(
                `[bundler] DecompressionStream not available, asset ${uuid} may not render`
              );
            }
          }

          // Create blob URL for asset
          blobUrls[uuid] = URL.createObjectURL(
            new Blob([finalBytes], { type: entry.mime })
          );
        } catch (err) {
          console.error(`[bundler] Failed to decode asset ${uuid}:`, err);
          blobUrls[uuid] = URL.createObjectURL(
            new Blob([], { type: entry.mime })
          );
        }
      })
    );

    // Load external resources mapping if present
    const extResEl = document.querySelector('script[type="__bundler/ext_resources"]');
    const extResources = extResEl ? JSON.parse(extResEl.textContent) : [];
    const resourceMap = {};

    for (const entry of extResources) {
      if (blobUrls[entry.uuid]) {
        resourceMap[entry.id] = blobUrls[entry.uuid];
      }
    }

    // Replace UUIDs in template with blob URLs
    setStatus('Rendering...');
    for (const uuid of uuids) {
      template = template.split(uuid).join(blobUrls[uuid]);
    }

    // Remove integrity and crossorigin attributes (incompatible with blob URLs)
    template = template
      .replace(/\s+integrity="[^"]*"/gi, '')
      .replace(/\s+crossorigin="[^"]*"/gi, '');

    // Inject resource map into page before rendering
    const resourceScript =
      '<script>window.__resources = ' +
      JSON.stringify(resourceMap).split('</' + 'script>').join('<\\/' + 'script>') +
      ';</' +
      'script>';

    const headOpen = template.match(/<head[^>]*>/i);
    if (headOpen) {
      const i = headOpen.index + headOpen[0].length;
      template = template.slice(0, i) + resourceScript + template.slice(i);
    }

    // Parse template and replace document
    const doc = new DOMParser().parseFromString(template, 'text/html');
    document.documentElement.replaceWith(doc.documentElement);

    // Re-create scripts to ensure they execute
    const dead = Array.from(document.scripts);
    for (const old of dead) {
      const s = document.createElement('script');

      for (const a of old.attributes) {
        s.setAttribute(a.name, a.value);
      }
      s.textContent = old.textContent;

      // For Babel scripts with src, fetch and inline the content
      if ((s.type === 'text/babel' || s.type === 'text/jsx') && s.src) {
        const r = await fetch(s.src);
        s.textContent = await r.text();
        s.removeAttribute('src');
      }

      const p = s.src ? new Promise(function (r) {
        s.onload = s.onerror = r;
      }) : null;

      old.replaceWith(s);
      if (p) await p;
    }

    // Trigger Babel transformation if available
    if (window.Babel && typeof window.Babel.transformScriptTags === 'function') {
      window.Babel.transformScriptTags();
    }
  } catch (err) {
    setStatus(`Error unpacking: ${err.message}`);
    console.error('[bundler] Unpack error:', err);
  }
});
