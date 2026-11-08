(() => {
  'use strict';

  const stage = document.getElementById('stage');
  const emptyEl = document.getElementById('empty');
  const onlineEl = document.getElementById('online');
  const nameInput = document.getElementById('name');
  const commentInput = document.getElementById('comment');
  const toastEl = document.getElementById('toast');

  /** id -> { el, nameEl, commentEl, nx, ny, tx, ty, lastMove } */
  const cursors = new Map();

  let selfId = null;
  let selfColor = '#8b7bff';
  let socket = null;
  let retry = 0;
  let lastSend = 0;
  let toastTimer = null;

  /* ---------- утилиты ---------- */

  const hexToRgba = (hex, alpha) => {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  };

  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
  }

  function send(payload) {
    if (socket && socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }

  /* ---------- отрисовка курсоров ---------- */

  function createCursor(user) {
    if (cursors.has(user.id)) return cursors.get(user.id);
    const isSelf = user.id === selfId;

    const el = document.createElement('div');
    el.className = 'cursor' + (isSelf ? ' self' : '');
    el.style.setProperty('--c', user.color);
    el.style.setProperty('--cs', hexToRgba(user.color, 0.5));
    el.style.setProperty('--cg', hexToRgba(user.color, 0.35));
    el.innerHTML = `
      <div class="halo"></div>
      <div class="ring"></div>
      <div class="dot"></div>
      <div class="bubble">
        <div class="comment-chip hidden"></div>
        <div class="name-chip"></div>
      </div>`;
    stage.appendChild(el);

    const c = {
      el,
      nameEl: el.querySelector('.name-chip'),
      commentEl: el.querySelector('.comment-chip'),
      nx: user.x,
      ny: user.y,
      tx: user.x,
      ty: user.y,
      lastMove: Date.now()
    };

    setComment(c, user.comment);
    setName(c, isSelf ? `${user.name} · ты` : user.name);

    cursors.set(user.id, c);
    updateEmpty();
    return c;
  }

  function setName(c, name) {
    c.nameEl.textContent = name;
  }

  function setComment(c, text) {
    const value = (text || '').trim();
    if (value) {
      c.commentEl.textContent = value;
      c.commentEl.classList.remove('hidden');
    } else {
      c.commentEl.textContent = '';
      c.commentEl.classList.add('hidden');
    }
  }

  function removeCursor(id) {
    const c = cursors.get(id);
    if (!c) return;
    c.el.remove();
    cursors.delete(id);
    updateEmpty();
  }

  function updateEmpty() {
    emptyEl.classList.toggle('hide', cursors.size > 1);
    onlineEl.textContent = String(cursors.size || 1);
  }

  /* ---------- плавная анимация ---------- */

  function frame() {
    const w = window.innerWidth;
    const h = window.innerHeight;

    for (const [id, c] of cursors) {
      const ease = id === selfId ? 1 : 0.22;
      c.nx += (c.tx - c.nx) * ease;
      c.ny += (c.ty - c.ny) * ease;
      c.el.style.transform = `translate3d(${(c.nx * w).toFixed(2)}px, ${(c.ny * h).toFixed(2)}px, 0)`;
      c.el.classList.toggle('idle', id !== selfId && Date.now() - c.lastMove > 9000);
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  /* ---------- ввод ---------- */

  window.addEventListener('mousemove', (e) => {
    const nx = e.clientX / window.innerWidth;
    const ny = e.clientY / window.innerHeight;

    const self = selfId && cursors.get(selfId);
    if (self) {
      self.tx = nx;
      self.ty = ny;
      self.lastMove = Date.now();
    }

    const now = performance.now();
    if (now - lastSend > 40) {
      lastSend = now;
      send({ type: 'cursor', x: nx, y: ny });
    }
  });

  window.addEventListener('pointerdown', (e) => {
    const rip = document.createElement('div');
    rip.className = 'ripple';
    rip.style.setProperty('--c', selfColor);
    rip.style.left = `${e.clientX}px`;
    rip.style.top = `${e.clientY}px`;
    stage.appendChild(rip);
    setTimeout(() => rip.remove(), 700);
  });

  commentInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const text = commentInput.value.trim();
      send({ type: 'comment', text });
      const self = selfId && cursors.get(selfId);
      if (self) setComment(self, text);
      commentInput.value = '';
      toast(text ? 'Комментарий закреплён над курсором' : 'Комментарий убран');
      e.preventDefault();
    }
    if (e.key === 'Escape') {
      commentInput.value = '';
      send({ type: 'comment', text: '' });
      const self = selfId && cursors.get(selfId);
      if (self) setComment(self, '');
    }
  });

  let renameTimer = null;
  nameInput.addEventListener('input', () => {
    const name = nameInput.value.trim();
    if (!name) return;
    const self = selfId && cursors.get(selfId);
    if (self) setName(self, `${name} · ты`);
    clearTimeout(renameTimer);
    renameTimer = setTimeout(() => send({ type: 'rename', name }), 350);
  });

  async function share() {
    try {
      await navigator.clipboard.writeText(location.href);
      toast('Ссылка скопирована — отправь другу');
    } catch {
      toast(location.href);
    }
  }

  document.getElementById('share').addEventListener('click', share);
  document.getElementById('share2').addEventListener('click', share);

  /* ---------- websocket ---------- */

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${proto}//${location.host}`);

    socket.addEventListener('open', () => {
      retry = 0;
    });

    socket.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      switch (msg.type) {
        case 'init': {
          selfId = msg.you.id;
          selfColor = msg.you.color;

          const me = createCursor(msg.you);
          me.nx = me.tx;
          me.ny = me.ty;

          nameInput.value = msg.you.name;
          if (msg.you.comment) commentInput.placeholder = `Твой комментарий: ${msg.you.comment}`;

          const seen = new Set();
          for (const u of msg.users) {
            seen.add(u.id);
            createCursor(u);
          }
          for (const id of [...cursors.keys()]) {
            if (id !== selfId && !seen.has(id)) removeCursor(id);
          }
          updateEmpty();
          break;
        }
        case 'join':
          createCursor(msg.user);
          break;
        case 'leave':
          removeCursor(msg.id);
          break;
        case 'move': {
          const c = cursors.get(msg.id);
          if (c) {
            c.tx = msg.x;
            c.ty = msg.y;
            c.lastMove = Date.now();
          }
          break;
        }
        case 'comment': {
          const c = cursors.get(msg.id);
          if (c) setComment(c, msg.text);
          break;
        }
        case 'rename': {
          const c = cursors.get(msg.id);
          if (c) setName(c, msg.id === selfId ? `${msg.name} · ты` : msg.name);
          break;
        }
      }
    });

    socket.addEventListener('close', () => {
      retry += 1;
      toast('Связь потеряна, переподключаюсь…');
      setTimeout(connect, Math.min(1000 * retry, 6000));
    });

    socket.addEventListener('error', () => socket.close());
  }

  connect();
})();
