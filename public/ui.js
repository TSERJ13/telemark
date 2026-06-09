/**
 * Telemark UI - Custom Toast and Confirm Modals
 */

const style = document.createElement('style');
style.textContent = `
/* Toast Container */
#tm-toast-container {
  position: fixed;
  top: 20px;
  right: 20px;
  z-index: 99999;
  display: flex;
  flex-direction: column;
  gap: 10px;
  pointer-events: none;
}

/* Toast Notification */
.tm-toast {
  background: var(--surface, #1e1e1e);
  color: var(--ink, #fff);
  border-left: 4px solid var(--accent, #646cff);
  padding: 14px 20px;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  font-family: inherit;
  font-size: 14px;
  min-width: 280px;
  max-width: 400px;
  pointer-events: auto;
  opacity: 0;
  transform: translateX(50px);
  animation: tmToastSlideIn 0.3s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
  position: relative;
  overflow: hidden;
}

.tm-toast.error { border-left-color: var(--danger, #ff5252); }
.tm-toast.success { border-left-color: var(--success, #4caf50); }

@keyframes tmToastSlideIn {
  to { opacity: 1; transform: translateX(0); }
}

@keyframes tmToastSlideOut {
  to { opacity: 0; transform: translateX(50px); }
}

/* Modal Overlay */
#tm-modal-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.7);
  backdrop-filter: blur(4px);
  z-index: 100000;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.2s ease;
}

/* Modal Box */
.tm-modal {
  background: var(--bg, #0f0f0f);
  border: 1px solid var(--line, rgba(255,255,255,0.1));
  border-radius: 16px;
  padding: 24px;
  width: 90%;
  max-width: 400px;
  box-shadow: 0 16px 40px rgba(0,0,0,0.6);
  transform: scale(0.95) translateY(10px);
  transition: all 0.2s cubic-bezier(0.2, 0.8, 0.2, 1);
  text-align: center;
}

.tm-modal.show {
  transform: scale(1) translateY(0);
}

.tm-modal-msg {
  font-size: 16px;
  color: var(--ink, #fff);
  margin-bottom: 24px;
  line-height: 1.5;
}

.tm-modal-actions {
  display: flex;
  gap: 12px;
  justify-content: center;
}

.tm-modal-btn {
  padding: 10px 20px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  border: none;
  outline: none;
  transition: all 0.2s;
}

.tm-modal-btn.cancel {
  background: rgba(255,255,255,0.1);
  color: var(--ink, #fff);
}

.tm-modal-btn.cancel:hover {
  background: rgba(255,255,255,0.15);
}

.tm-modal-btn.confirm {
  background: var(--accent, #646cff);
  color: #fff;
}

.tm-modal-btn.confirm:hover {
  filter: brightness(1.1);
}
`;
document.head.appendChild(style);

// Add Toast Container
const toastContainer = document.createElement('div');
toastContainer.id = 'tm-toast-container';
document.addEventListener('DOMContentLoaded', () => {
  document.body.appendChild(toastContainer);
});

window.showToast = function(msg, type = 'default') {
  if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('fail') || msg.toLowerCase().includes('შეცდომა')) {
    type = 'error';
  } else if (msg.toLowerCase().includes('success') || msg.toLowerCase().includes('წარმატებით')) {
    type = 'success';
  }

  const toast = document.createElement('div');
  toast.className = 'tm-toast ' + type;
  toast.innerHTML = msg;
  
  if (!document.getElementById('tm-toast-container')) {
    document.body.appendChild(toastContainer);
  }
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'tmToastSlideOut 0.3s cubic-bezier(0.2, 0.8, 0.2, 1) forwards';
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 300);
  }, 3000);
};

window.asyncConfirm = function(msg) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.id = 'tm-modal-overlay';
    
    const modal = document.createElement('div');
    modal.className = 'tm-modal';
    
    const text = document.createElement('div');
    text.className = 'tm-modal-msg';
    text.innerHTML = msg;
    
    const actions = document.createElement('div');
    actions.className = 'tm-modal-actions';
    
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'tm-modal-btn cancel';
    cancelBtn.textContent = typeof window.t === 'function' ? window.t('cancel') : 'Cancel';
    
    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'tm-modal-btn confirm';
    confirmBtn.textContent = typeof window.t === 'function' ? window.t('confirm') : 'Confirm';
    
    const cleanup = (result) => {
      overlay.style.opacity = '0';
      modal.style.transform = 'scale(0.95) translateY(10px)';
      setTimeout(() => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(result);
      }, 200);
    };
    
    cancelBtn.onclick = () => cleanup(false);
    confirmBtn.onclick = () => cleanup(true);
    
    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    
    modal.appendChild(text);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    
    // Animate in
    requestAnimationFrame(() => {
      overlay.style.opacity = '1';
      modal.classList.add('show');
    });
  });
};
