(function() {
  var SERVER = 'https://retreat-file-server.onrender.com';
  
  // ========== PART 1: Receipt PNG via Server ==========
  var _checkInterval = setInterval(function() {
    if (typeof window.raGenerateReceiptPDF !== 'function') return;
    clearInterval(_checkInterval);
    if (window.raGenerateReceiptPDF._pngOverride) return;
    
    console.log('[Receipt Override] Applying server-side PNG generation...');
    
    var _origFn = window.raGenerateReceiptPDF;
    window.raGenerateReceiptPDF = function(bookingId, invoiceIdx) {
      var url = SERVER + '/generate-receipt-image/' + bookingId + '/' + invoiceIdx;
      if(typeof raToast==='function') raToast('\u062c\u0627\u0631\u064a \u062a\u0648\u0644\u064a\u062f \u0627\u0644\u0625\u064a\u0635\u0627\u0644...', 'info');
      
      fetch(url)
        .then(function(r) {
          if (!r.ok) throw new Error('Server error ' + r.status);
          var cdnUrl = r.headers.get('X-CDN-URL');
          return r.blob().then(function(blob) { return { blob: blob, cdnUrl: cdnUrl }; });
        })
        .then(function(result) {
          var a = document.createElement('a');
          a.href = result.cdnUrl || URL.createObjectURL(result.blob);
          a.download = 'receipt-' + bookingId + '-' + invoiceIdx + '.png';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          if (!result.cdnUrl) URL.revokeObjectURL(a.href);
          if(typeof raToast==='function') raToast('\u2705 \u062a\u0645 \u062a\u062d\u0645\u064a\u0644 \u0627\u0644\u0625\u064a\u0635\u0627\u0644', 'success');
        })
        .catch(function(err) {
          console.error('[Receipt] Server generation error:', err);
          if(typeof raToast==='function') raToast('\u274c \u0641\u0634\u0644 \u062a\u0648\u0644\u064a\u062f \u0627\u0644\u0625\u064a\u0635\u0627\u0644: ' + err.message, 'error');
        });
    };
    
    window.raGenerateReceiptPDF._pngOverride = true;
    console.log('[Receipt Override] Server-side PNG generation applied!');
  }, 500);
  
  // ========== PART 2: UI Enhancements ==========
  var _uiInterval = setInterval(function() {
    var cards = document.querySelectorAll('[id^="ra-card-"]');
    if (cards.length === 0) return;
    clearInterval(_uiInterval);
    
    console.log('[UI Override] Enhancing buttons for ' + cards.length + ' booking cards...');
    
    cards.forEach(function(card) {
      var bookingId = card.id.replace('ra-card-', '');
      var allBtns = card.querySelectorAll('button.ra-btn');
      
      allBtns.forEach(function(btn) {
        if (btn.textContent.indexOf('\u0625\u064a\u0635\u0627\u0644\u0627\u062a') >= 0 && btn.textContent.indexOf('\u0625\u0646\u0634\u0627\u0621') < 0 && !btn.classList.contains('ra-view-receipts-btn')) {
          btn.textContent = '\ud83e\uddfe \u0625\u0646\u0634\u0627\u0621 \u0625\u064a\u0635\u0627\u0644';
          
          if (!card.querySelector('.ra-view-receipts-btn')) {
            var viewBtn = document.createElement('button');
            viewBtn.className = 'ra-btn ra-view-receipts-btn';
            viewBtn.style.cssText = 'background:#5a4a3a;color:#fff;margin:2px;padding:6px 10px;border:none;border-radius:6px;cursor:pointer;font-size:0.8rem;font-family:inherit;';
            viewBtn.textContent = '\ud83d\udcc4 \u0645\u0634\u0627\u0647\u062f\u0629 \u0627\u0644\u0625\u064a\u0635\u0627\u0644\u0627\u062a';
            viewBtn.onclick = function() { window._raViewReceipts(bookingId); };
            btn.parentNode.insertBefore(viewBtn, btn.nextSibling);
          }
        }
        
        if (btn.textContent.indexOf('\u0627\u0644\u0628\u0637\u0627\u0642\u0629') >= 0 && btn.textContent.indexOf('\u0627\u0644\u0645\u062f\u0646\u064a\u0629') >= 0) {
          btn.onclick = function() { window._raViewCivilIdEnhanced(bookingId); };
        }
      });
      
      var hasCivilBtn = false;
      allBtns.forEach(function(b) {
        if (b.textContent.indexOf('\u0627\u0644\u0628\u0637\u0627\u0642\u0629 \u0627\u0644\u0645\u062f\u0646\u064a\u0629') >= 0) hasCivilBtn = true;
      });
      if (!hasCivilBtn) {
        var actionsDiv = card.querySelector('.ra-booking-actions');
        if (!actionsDiv) {
          var btns = card.querySelectorAll('button.ra-btn');
          if (btns.length > 0) actionsDiv = btns[0].parentNode;
        }
        if (actionsDiv) {
          var civilBtn = document.createElement('button');
          civilBtn.className = 'ra-btn';
          civilBtn.style.cssText = 'background:#7a6b5a;color:#fff;margin:2px;padding:6px 10px;border:none;border-radius:6px;cursor:pointer;font-size:0.8rem;font-family:inherit;';
          civilBtn.textContent = '\ud83e\udeaa \u0627\u0644\u0628\u0637\u0627\u0642\u0629 \u0627\u0644\u0645\u062f\u0646\u064a\u0629';
          civilBtn.onclick = function() { window._raViewCivilIdEnhanced(bookingId); };
          var attachBtn = null;
          actionsDiv.querySelectorAll('button').forEach(function(b) {
            if (b.textContent.indexOf('\u0645\u0631\u0641\u0642\u0627\u062a') >= 0) attachBtn = b;
          });
          if (attachBtn) {
            actionsDiv.insertBefore(civilBtn, attachBtn);
          } else {
            actionsDiv.appendChild(civilBtn);
          }
        }
      }
    });
    
    console.log('[UI Override] Button enhancement complete!');
  }, 1000);
  
  // MutationObserver for dynamically added cards
  var _observer = new MutationObserver(function(mutations) {
    mutations.forEach(function(m) {
      m.addedNodes.forEach(function(node) {
        if (node.nodeType === 1 && node.id && node.id.startsWith('ra-card-')) {
          var bookingId = node.id.replace('ra-card-', '');
          setTimeout(function() {
            var allBtns = node.querySelectorAll('button.ra-btn');
            allBtns.forEach(function(btn) {
              if (btn.textContent.indexOf('\u0625\u064a\u0635\u0627\u0644\u0627\u062a') >= 0 && btn.textContent.indexOf('\u0625\u0646\u0634\u0627\u0621') < 0 && !btn.classList.contains('ra-view-receipts-btn')) {
                btn.textContent = '\ud83e\uddfe \u0625\u0646\u0634\u0627\u0621 \u0625\u064a\u0635\u0627\u0644';
                if (!node.querySelector('.ra-view-receipts-btn')) {
                  var viewBtn = document.createElement('button');
                  viewBtn.className = 'ra-btn ra-view-receipts-btn';
                  viewBtn.style.cssText = 'background:#5a4a3a;color:#fff;margin:2px;padding:6px 10px;border:none;border-radius:6px;cursor:pointer;font-size:0.8rem;font-family:inherit;';
                  viewBtn.textContent = '\ud83d\udcc4 \u0645\u0634\u0627\u0647\u062f\u0629 \u0627\u0644\u0625\u064a\u0635\u0627\u0644\u0627\u062a';
                  viewBtn.onclick = function() { window._raViewReceipts(bookingId); };
                  btn.parentNode.insertBefore(viewBtn, btn.nextSibling);
                }
              }
              if (btn.textContent.indexOf('\u0627\u0644\u0628\u0637\u0627\u0642\u0629') >= 0 && btn.textContent.indexOf('\u0627\u0644\u0645\u062f\u0646\u064a\u0629') >= 0) {
                btn.onclick = function() { window._raViewCivilIdEnhanced(bookingId); };
              }
            });
            var hasCivil = false;
            allBtns.forEach(function(b) { if (b.textContent.indexOf('\u0627\u0644\u0628\u0637\u0627\u0642\u0629 \u0627\u0644\u0645\u062f\u0646\u064a\u0629') >= 0) hasCivil = true; });
            if (!hasCivil) {
              var parent = allBtns.length > 0 ? allBtns[0].parentNode : null;
              if (parent) {
                var cb = document.createElement('button');
                cb.className = 'ra-btn';
                cb.style.cssText = 'background:#7a6b5a;color:#fff;margin:2px;padding:6px 10px;border:none;border-radius:6px;cursor:pointer;font-size:0.8rem;font-family:inherit;';
                cb.textContent = '\ud83e\udeaa \u0627\u0644\u0628\u0637\u0627\u0642\u0629 \u0627\u0644\u0645\u062f\u0646\u064a\u0629';
                cb.onclick = function() { window._raViewCivilIdEnhanced(bookingId); };
                parent.appendChild(cb);
              }
            }
          }, 200);
        }
      });
    });
  });
  setTimeout(function() {
    var container = document.getElementById('ra-bookings-container') || document.body;
    _observer.observe(container, { childList: true, subtree: true });
  }, 2000);
  
  // ========== PART 3: View Receipts Function ==========
  window._raViewReceipts = function(bookingId) {
    // First try local store, then fetch from server
    var localStore = (typeof getInvoiceStore === 'function') ? getInvoiceStore() : JSON.parse(localStorage.getItem('ra_invoices') || '{}');
    var localInvoices = localStore[bookingId] || [];
    var b = (typeof allBookings !== 'undefined') ? allBookings.find(function(x){return String(x.id)===String(bookingId);}) : null;
    var name = b ? (b.name || b.guest_name || '') : bookingId;
    
    // Always fetch from server to get the latest
    fetch(SERVER + '/get-invoices')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var serverInvoices = (data.invoices && data.invoices[bookingId]) || [];
        // Merge: prefer server invoices, fallback to local
        var invoices = serverInvoices.length > 0 ? serverInvoices : localInvoices;
        window._raShowReceiptsModal(bookingId, invoices, name);
      })
      .catch(function(err) {
        console.error('[ViewReceipts] Server fetch error:', err);
        // Fallback to local
        window._raShowReceiptsModal(bookingId, localInvoices, name);
      });
  };
  
  window._raShowReceiptsModal = function(bookingId, invoices, name) {
    
    var existing = document.getElementById('ra-receipts-overlay');
    if (existing) existing.remove();
    
    var overlay = document.createElement('div');
    overlay.id = 'ra-receipts-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px;';
    overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
    
    var box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:12px;max-width:550px;width:100%;max-height:90vh;overflow:auto;padding:20px;position:relative;direction:rtl;font-family:Tajawal,Arial,sans-serif;';
    
    var header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;';
    var h3 = document.createElement('h3');
    h3.style.cssText = 'margin:0;font-size:1.1rem;color:#1B4332;';
    h3.textContent = '\ud83d\udcca \u0627\u0644\u0625\u064a\u0635\u0627\u0644\u0627\u062a \u0627\u0644\u0635\u0627\u062f\u0631\u0629 - ' + name;
    var closeBtn = document.createElement('button');
    closeBtn.style.cssText = 'background:none;border:none;font-size:1.5rem;cursor:pointer;color:#999;';
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = function() { overlay.remove(); };
    header.appendChild(h3);
    header.appendChild(closeBtn);
    box.appendChild(header);
    
    if (invoices.length === 0) {
      var empty = document.createElement('div');
      empty.style.cssText = 'text-align:center;padding:40px 20px;color:#999;';
      empty.innerHTML = '<p style="font-size:2rem;margin:0;">\ud83d\udcc4</p><p style="margin:8px 0 0;">\u0644\u0627 \u062a\u0648\u062c\u062f \u0625\u064a\u0635\u0627\u0644\u0627\u062a \u0635\u0627\u062f\u0631\u0629 \u0644\u0647\u0630\u0627 \u0627\u0644\u062d\u062c\u0632</p>';
      box.appendChild(empty);
    } else {
      invoices.forEach(function(inv, idx) {
        var typeLabel = inv.type === 'deposit' ? '\u0639\u0631\u0628\u0648\u0646' : '\u0625\u064a\u062c\u0627\u0631';
        var typeColor = inv.type === 'deposit' ? '#c9a84c' : '#2d6a4f';
        var date = inv.date || (inv.createdAt ? new Date(inv.createdAt).toLocaleDateString('en-GB') : '-');
        
        var card = document.createElement('div');
        card.style.cssText = 'border:1px solid #e8e0d4;border-radius:8px;padding:12px;margin-bottom:10px;background:#faf8f4;';
        
        var row1 = document.createElement('div');
        row1.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;';
        var badge = document.createElement('span');
        badge.style.cssText = 'background:'+typeColor+';color:#fff;padding:3px 10px;border-radius:12px;font-size:0.75rem;';
        badge.textContent = typeLabel;
        var dateSpan = document.createElement('span');
        dateSpan.style.cssText = 'color:#888;font-size:0.8rem;';
        dateSpan.textContent = date;
        row1.appendChild(badge);
        row1.appendChild(dateSpan);
        card.appendChild(row1);
        
        var row2 = document.createElement('div');
        row2.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
        var amount = document.createElement('span');
        amount.style.cssText = 'font-weight:bold;font-size:1.1rem;color:#1B4332;';
        amount.textContent = inv.amount + ' \u062f.\u0643';
        var btnsDiv = document.createElement('div');
        btnsDiv.style.cssText = 'display:flex;gap:6px;';
        
        var viewBtn = document.createElement('button');
        viewBtn.style.cssText = 'background:#5a4a3a;color:#fff;border:none;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:0.8rem;';
        viewBtn.textContent = '\ud83d\udc41 \u0645\u0634\u0627\u0647\u062f\u0629';
        (function(bid, i) {
          viewBtn.onclick = function() { window._raViewReceiptImage(bid, i); };
        })(bookingId, idx);
        
        var dlBtn = document.createElement('button');
        dlBtn.style.cssText = 'background:#2d6a4f;color:#fff;border:none;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:0.8rem;';
        dlBtn.textContent = '\ud83d\udce5 \u062a\u062d\u0645\u064a\u0644';
        (function(bid, i) {
          dlBtn.onclick = function() { window.raGenerateReceiptPDF(bid, i); };
        })(bookingId, idx);
        
        btnsDiv.appendChild(viewBtn);
        btnsDiv.appendChild(dlBtn);
        row2.appendChild(amount);
        row2.appendChild(btnsDiv);
        card.appendChild(row2);
        
        if (inv.notes) {
          var notes = document.createElement('p');
          notes.style.cssText = 'margin:6px 0 0;color:#888;font-size:0.8rem;';
          notes.textContent = '\ud83d\udcdd ' + inv.notes;
          card.appendChild(notes);
        }
        if (inv.number) {
          var num = document.createElement('p');
          num.style.cssText = 'margin:4px 0 0;color:#aaa;font-size:0.75rem;';
          num.textContent = '\u0631\u0642\u0645: ' + inv.number;
          card.appendChild(num);
        }
        
        box.appendChild(card);
      });
    }
    
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  };
  
  // ========== PART 4: Enhanced Civil ID View with Upload ==========
  window._raViewCivilIdEnhanced = function(bookingId) {
    var b = (typeof allBookings !== 'undefined') ? allBookings.find(function(x){return String(x.id)===String(bookingId);}) : null;
    var name = b ? (b.name || b.guest_name || '') : '';
    
    var existing = document.getElementById('ra-civilid-overlay');
    if (existing) existing.remove();
    
    var overlay = document.createElement('div');
    overlay.id = 'ra-civilid-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px;';
    overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
    
    var loadDiv = document.createElement('div');
    loadDiv.style.cssText = 'background:#fff;border-radius:12px;max-width:500px;width:100%;padding:30px;text-align:center;direction:rtl;font-family:Tajawal,Arial,sans-serif;';
    loadDiv.innerHTML = '<p style="font-size:1.2rem;">\u062c\u0627\u0631\u064a \u0627\u0644\u062a\u062d\u0645\u064a\u0644...</p>';
    overlay.appendChild(loadDiv);
    document.body.appendChild(overlay);
    
    fetch(SERVER + '/get-civil-id/' + bookingId)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.success && data.imageUrl) {
          showCivilIdContent(overlay, bookingId, name, data.imageUrl);
        } else {
          showCivilIdUploadForm(overlay, bookingId, name);
        }
      })
      .catch(function() {
        if (b && b.civilIdImageUrl && b.civilIdImageUrl !== 'STORED_IN_IMAGES' && (b.civilIdImageUrl.startsWith('data:') || b.civilIdImageUrl.startsWith('http'))) {
          showCivilIdContent(overlay, bookingId, name, b.civilIdImageUrl);
        } else {
          showCivilIdUploadForm(overlay, bookingId, name);
        }
      });
  };
  
  function showCivilIdContent(overlay, bookingId, name, imageUrl) {
    overlay.innerHTML = '';
    var box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:12px;max-width:500px;width:100%;max-height:90vh;overflow:auto;padding:16px;position:relative;direction:rtl;font-family:Tajawal,Arial,sans-serif;';
    
    var header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;';
    var h3 = document.createElement('h3');
    h3.style.cssText = 'margin:0;font-size:1rem;color:#3d3d3d;';
    h3.textContent = '\ud83e\udeaa \u0627\u0644\u0628\u0637\u0627\u0642\u0629 \u0627\u0644\u0645\u062f\u0646\u064a\u0629 - ' + name;
    var closeBtn = document.createElement('button');
    closeBtn.style.cssText = 'background:none;border:none;font-size:1.5rem;cursor:pointer;color:#999;';
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = function() { overlay.remove(); };
    header.appendChild(h3);
    header.appendChild(closeBtn);
    box.appendChild(header);
    
    var img = document.createElement('img');
    img.src = imageUrl;
    img.alt = '\u0628\u0637\u0627\u0642\u0629 \u0645\u062f\u0646\u064a\u0629';
    img.style.cssText = 'width:100%;border-radius:8px;border:2px solid #c9a961;object-fit:contain;display:block;background:#f5f0e8;';
    box.appendChild(img);
    
    var btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:8px;margin-top:10px;';
    var dlLink = document.createElement('a');
    dlLink.href = imageUrl;
    dlLink.download = 'civil-id-' + bookingId + '.jpg';
    dlLink.style.cssText = 'flex:1;display:block;padding:10px;background:#c9a961;color:#fff;border-radius:6px;font-size:0.85rem;font-weight:600;text-align:center;text-decoration:none;';
    dlLink.textContent = '\ud83d\udcf7 \u062a\u062d\u0645\u064a\u0644 \u0627\u0644\u0635\u0648\u0631\u0629';
    var replaceBtn = document.createElement('button');
    replaceBtn.style.cssText = 'flex:1;padding:10px;background:#7a6b5a;color:#fff;border:none;border-radius:6px;font-size:0.85rem;font-weight:600;cursor:pointer;';
    replaceBtn.textContent = '\ud83d\udd04 \u062a\u063a\u064a\u064a\u0631 \u0627\u0644\u0635\u0648\u0631\u0629';
    replaceBtn.onclick = function() { window._raReplaceCivilId(bookingId, name); };
    btns.appendChild(dlLink);
    btns.appendChild(replaceBtn);
    box.appendChild(btns);
    
    overlay.appendChild(box);
  }
  
  function showCivilIdUploadForm(overlay, bookingId, name) {
    overlay.innerHTML = '';
    var box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:12px;max-width:500px;width:100%;padding:20px;position:relative;direction:rtl;font-family:Tajawal,Arial,sans-serif;';
    
    var header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;';
    var h3 = document.createElement('h3');
    h3.style.cssText = 'margin:0;font-size:1rem;color:#3d3d3d;';
    h3.textContent = '\ud83e\udeaa \u0627\u0644\u0628\u0637\u0627\u0642\u0629 \u0627\u0644\u0645\u062f\u0646\u064a\u0629 - ' + name;
    var closeBtn = document.createElement('button');
    closeBtn.style.cssText = 'background:none;border:none;font-size:1.5rem;cursor:pointer;color:#999;';
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = function() { overlay.remove(); };
    header.appendChild(h3);
    header.appendChild(closeBtn);
    box.appendChild(header);
    
    var dropZone = document.createElement('div');
    dropZone.style.cssText = 'text-align:center;padding:30px;border:2px dashed #c9a961;border-radius:8px;background:#faf8f4;margin-bottom:12px;';
    dropZone.innerHTML = '<p style="font-size:2.5rem;margin:0;">\ud83d\udcf7</p>'
      + '<p style="margin:8px 0;color:#666;">\u0644\u0627 \u062a\u0648\u062c\u062f \u0635\u0648\u0631\u0629 \u0644\u0644\u0628\u0637\u0627\u0642\u0629 \u0627\u0644\u0645\u062f\u0646\u064a\u0629</p>'
      + '<p style="margin:4px 0;color:#999;font-size:0.85rem;">\u0627\u062e\u062a\u0631 \u0635\u0648\u0631\u0629 \u0644\u0631\u0641\u0639\u0647\u0627</p>'
      + '<div id="ra-civil-preview" style="margin-top:10px;"></div>';
    box.appendChild(dropZone);
    
    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.id = 'ra-civil-upload-input';
    fileInput.accept = 'image/*';
    fileInput.style.display = 'none';
    fileInput.onchange = function() { window._raCivilIdPreview(fileInput); };
    box.appendChild(fileInput);
    
    var btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:8px;';
    var chooseBtn = document.createElement('button');
    chooseBtn.style.cssText = 'flex:1;padding:10px;background:#c9a961;color:#fff;border:none;border-radius:6px;font-size:0.85rem;font-weight:600;cursor:pointer;';
    chooseBtn.textContent = '\ud83d\udcc2 \u0627\u062e\u062a\u064a\u0627\u0631 \u0635\u0648\u0631\u0629';
    chooseBtn.onclick = function() { fileInput.click(); };
    var uploadBtn = document.createElement('button');
    uploadBtn.id = 'ra-civil-upload-btn';
    uploadBtn.style.cssText = 'flex:1;padding:10px;background:#2d6a4f;color:#fff;border:none;border-radius:6px;font-size:0.85rem;font-weight:600;cursor:pointer;opacity:0.5;';
    uploadBtn.textContent = '\u2b06\ufe0f \u0631\u0641\u0639';
    uploadBtn.disabled = true;
    uploadBtn.onclick = function() { window._raUploadCivilId(bookingId); };
    btns.appendChild(chooseBtn);
    btns.appendChild(uploadBtn);
    box.appendChild(btns);
    
    overlay.appendChild(box);
  }
  
  window._raCivilIdPreview = function(input) {
    var preview = document.getElementById('ra-civil-preview');
    var uploadBtn = document.getElementById('ra-civil-upload-btn');
    if (input.files && input.files[0]) {
      var reader = new FileReader();
      reader.onload = function(e) {
        preview.innerHTML = '<img src="'+e.target.result+'" style="max-width:100%;max-height:200px;border-radius:6px;border:1px solid #ddd;" />';
        uploadBtn.disabled = false;
        uploadBtn.style.opacity = '1';
      };
      reader.readAsDataURL(input.files[0]);
    }
  };
  
  window._raUploadCivilId = function(bookingId) {
    var input = document.getElementById('ra-civil-upload-input');
    if (!input.files || !input.files[0]) return;
    
    var uploadBtn = document.getElementById('ra-civil-upload-btn');
    uploadBtn.textContent = '\u062c\u0627\u0631\u064a \u0627\u0644\u0631\u0641\u0639...';
    uploadBtn.disabled = true;
    
    var formData = new FormData();
    formData.append('file', input.files[0]);
    
    fetch(SERVER + '/upload-civil-id/' + bookingId, {
      method: 'POST',
      body: formData
    }).then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.success) {
        if(typeof raToast==='function') raToast('\u2705 \u062a\u0645 \u0631\u0641\u0639 \u0627\u0644\u0628\u0637\u0627\u0642\u0629 \u0627\u0644\u0645\u062f\u0646\u064a\u0629 \u0628\u0646\u062c\u0627\u062d', 'success');
        document.getElementById('ra-civilid-overlay').remove();
        setTimeout(function() { window._raViewCivilIdEnhanced(bookingId); }, 500);
      } else {
        if(typeof raToast==='function') raToast('\u274c \u0641\u0634\u0644 \u0627\u0644\u0631\u0641\u0639: ' + (data.error || ''), 'error');
        uploadBtn.textContent = '\u2b06\ufe0f \u0631\u0641\u0639';
        uploadBtn.disabled = false;
      }
    }).catch(function(err) {
      if(typeof raToast==='function') raToast('\u274c \u062e\u0637\u0623: ' + err.message, 'error');
      uploadBtn.textContent = '\u2b06\ufe0f \u0631\u0641\u0639';
      uploadBtn.disabled = false;
    });
  };
  
  window._raReplaceCivilId = function(bookingId, name) {
    var overlay = document.getElementById('ra-civilid-overlay');
    if (overlay) showCivilIdUploadForm(overlay, bookingId, name);
  };
  
  // ========== PART 5: View Receipt as Image ==========
  window._raViewReceiptImage = function(bookingId, invoiceIdx) {
    var existing = document.getElementById('ra-receipt-image-overlay');
    if (existing) existing.remove();
    
    var overlay = document.createElement('div');
    overlay.id = 'ra-receipt-image-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.9);z-index:999999;display:flex;align-items:center;justify-content:center;padding:16px;';
    overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
    
    var loadDiv = document.createElement('div');
    loadDiv.style.cssText = 'text-align:center;color:#fff;font-family:Tajawal,Arial,sans-serif;';
    loadDiv.innerHTML = '<p>\u062c\u0627\u0631\u064a \u062a\u0648\u0644\u064a\u062f \u0627\u0644\u0625\u064a\u0635\u0627\u0644...</p>';
    overlay.appendChild(loadDiv);
    document.body.appendChild(overlay);
    
    var imgUrl = SERVER + '/generate-receipt-image/' + bookingId + '/' + invoiceIdx;
    
    var img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = function() {
      overlay.innerHTML = '';
      var box = document.createElement('div');
      box.style.cssText = 'background:#fff;border-radius:12px;max-width:550px;width:100%;max-height:90vh;overflow:auto;padding:16px;position:relative;direction:rtl;font-family:Tajawal,Arial,sans-serif;';
      
      var header = document.createElement('div');
      header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;';
      var title = document.createElement('h3');
      title.style.cssText = 'margin:0;font-size:1rem;color:#1B4332;';
      title.textContent = '\ud83e\uddfe \u0627\u0644\u0625\u064a\u0635\u0627\u0644';
      var closeBtn = document.createElement('button');
      closeBtn.style.cssText = 'background:none;border:none;font-size:1.5rem;cursor:pointer;color:#999;';
      closeBtn.innerHTML = '&times;';
      closeBtn.onclick = function() { overlay.remove(); };
      header.appendChild(title);
      header.appendChild(closeBtn);
      box.appendChild(header);
      
      var imgEl = document.createElement('img');
      imgEl.src = imgUrl;
      imgEl.style.cssText = 'width:100%;border-radius:8px;border:1px solid #ddd;';
      box.appendChild(imgEl);
      
      var btns = document.createElement('div');
      btns.style.cssText = 'display:flex;gap:8px;margin-top:10px;';
      var dlBtn = document.createElement('button');
      dlBtn.style.cssText = 'flex:1;padding:10px;background:#2d6a4f;color:#fff;border:none;border-radius:6px;font-size:0.85rem;font-weight:600;cursor:pointer;';
      dlBtn.textContent = '\ud83d\udce5 \u062a\u062d\u0645\u064a\u0644';
      dlBtn.onclick = function() { window.raGenerateReceiptPDF(bookingId, invoiceIdx); };
      var clBtn = document.createElement('button');
      clBtn.style.cssText = 'flex:1;padding:10px;background:#7a6b5a;color:#fff;border:none;border-radius:6px;font-size:0.85rem;font-weight:600;cursor:pointer;';
      clBtn.textContent = '\u2716 \u0625\u063a\u0644\u0627\u0642';
      clBtn.onclick = function() { overlay.remove(); };
      btns.appendChild(dlBtn);
      btns.appendChild(clBtn);
      box.appendChild(btns);
      
      overlay.appendChild(box);
    };
    img.onerror = function() {
      overlay.innerHTML = '';
      var errBox = document.createElement('div');
      errBox.style.cssText = 'background:#fff;border-radius:12px;max-width:400px;width:100%;padding:30px;text-align:center;direction:rtl;font-family:Tajawal,Arial,sans-serif;';
      errBox.innerHTML = '<p style="font-size:2rem;">\u274c</p><p>\u0641\u0634\u0644 \u062a\u0648\u0644\u064a\u062f \u0627\u0644\u0625\u064a\u0635\u0627\u0644</p>';
      var errBtn = document.createElement('button');
      errBtn.style.cssText = 'margin-top:10px;padding:8px 20px;background:#7a6b5a;color:#fff;border:none;border-radius:6px;cursor:pointer;';
      errBtn.textContent = '\u0625\u063a\u0644\u0627\u0642';
      errBtn.onclick = function() { overlay.remove(); };
      errBox.appendChild(errBtn);
      overlay.appendChild(errBox);
    };
    img.src = imgUrl;
  };
  
  console.log('[Receipt Override] All enhancements loaded.');
})();
