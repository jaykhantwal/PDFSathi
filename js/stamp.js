/* Stamp renderer – draws round seals, rubber stamps, badges on a canvas. */
(function () {
  const PS = (window.PS = window.PS || {});

  const FONTS = {
    sans: '"Plus Jakarta Sans","Hind",sans-serif',
    serif: '"Lora","Hind",serif',
    mono: '"Roboto Mono","Hind",monospace',
    hindi: '"Hind","Plus Jakarta Sans",sans-serif',
  };
  const BW = { thin: 6, medium: 10, thick: 16 };
  const DIMS = { circle: [600, 600], seal: [600, 600], oval: [780, 520], rect: [820, 380], rounded: [820, 380] };
  PS.STAMP_DIMS = DIMS;

  PS.STAMP_PRESETS = [
    { name: 'APPROVED', shape: 'rect', text1: 'APPROVED', text2: '', text3: '', color: '#15803d', font: 'sans', border: 'medium', date: true, rubber: 1, tilt: -8 },
    { name: 'PAID', shape: 'rounded', text1: 'PAID', text2: '', text3: '', color: '#dc2626', font: 'sans', border: 'thick', date: true, rubber: 1, tilt: -10 },
    { name: 'REJECTED', shape: 'rect', text1: 'REJECTED', text2: '', text3: '', color: '#dc2626', font: 'sans', border: 'thick', date: false, rubber: 1, tilt: 6 },
    { name: 'CONFIDENTIAL', shape: 'rect', text1: 'CONFIDENTIAL', text2: '', text3: '', color: '#1d4ed8', font: 'mono', border: 'medium', date: false, rubber: 1, tilt: 0 },
    { name: 'Company seal', shape: 'seal', text1: 'OFFICIAL\nSEAL', text2: 'YOUR COMPANY NAME', text3: 'EST. 2024 • INDIA', color: '#1d4ed8', font: 'serif', border: 'medium', date: false, rubber: 0, tilt: 0 },
    { name: 'RECEIVED', shape: 'circle', text1: 'RECEIVED', text2: '', text3: '', color: '#7c3aed', font: 'sans', border: 'medium', date: true, rubber: 1, tilt: -12 },
    { name: 'VERIFIED', shape: 'oval', text1: 'VERIFIED', text2: '', text3: '', color: '#0f766e', font: 'serif', border: 'medium', date: true, rubber: 0, tilt: 0 },
    { name: 'स्वीकृत', shape: 'rounded', text1: 'स्वीकृत', text2: '', text3: '', color: '#15803d', font: 'hindi', border: 'thick', date: true, rubber: 1, tilt: -6 },
    { name: 'भुगतान हो गया', shape: 'rect', text1: 'भुगतान हो गया', text2: '', text3: '', color: '#dc2626', font: 'hindi', border: 'medium', date: true, rubber: 1, tilt: -8 },
  ];

  function rng(seed) {
    let s = (seed >>> 0) || 1;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  }

  PS.loadStampFonts = function (sampleText) {
    const t = sampleText || 'Aa अआ';
    return Promise.all(
      ['400', '700', '800'].flatMap((w) =>
        ['Plus Jakarta Sans', 'Lora', 'Roboto Mono', 'Hind'].map((f) =>
          document.fonts.load(`${w} 40px "${f}"`, t).catch(() => {})
        )
      )
    );
  };

  function ring(x, cx, cy, r, w) {
    x.lineWidth = w;
    x.beginPath();
    x.arc(cx, cy, r, 0, Math.PI * 2);
    x.stroke();
  }
  function rrect(x, l, t, w, h, r) {
    x.beginPath();
    x.moveTo(l + r, t);
    x.arcTo(l + w, t, l + w, t + h, r);
    x.arcTo(l + w, t + h, l, t + h, r);
    x.arcTo(l, t + h, l, t, r);
    x.arcTo(l, t, l + w, t, r);
    x.closePath();
  }
  function star(x, cx, cy, R) {
    const r = R * 0.45;
    x.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const rr = i % 2 ? r : R;
      x.lineTo(cx + rr * Math.cos(a), cy + rr * Math.sin(a));
    }
    x.closePath();
    x.fill();
  }

  /* centred block of text lines, auto-fitted */
  function block(x, parts, cx, cy, maxW, maxH, fam) {
    if (!parts.length) return;
    const total = (fs) => parts.reduce((h, p) => h + fs * p.rel * 1.18, 0);
    let fs = 220;
    for (; fs > 12; fs -= 2) {
      let ok = total(fs) <= maxH;
      if (ok) {
        for (const p of parts) {
          x.font = `${p.rel === 1 ? 800 : 700} ${fs * p.rel}px ${fam}`;
          if (x.measureText(p.text).width > maxW) { ok = false; break; }
        }
      }
      if (ok) break;
    }
    let y = cy - total(fs) / 2;
    for (const p of parts) {
      const h = fs * p.rel * 1.18;
      x.font = `${p.rel === 1 ? 800 : 700} ${fs * p.rel}px ${fam}`;
      x.fillText(p.text, cx, y + h / 2 + fs * p.rel * 0.04);
      y += h;
    }
  }

  /* text along a circle. bottom=true keeps text upright along the bottom */
  function arcText(x, text, cx, cy, r, centre, fs, fam, bottom, maxAngle) {
    if (!text) return;
    let size = fs;
    let widths, total;
    for (;;) {
      x.font = `800 ${size}px ${fam}`;
      widths = [...text].map((ch) => x.measureText(ch).width + size * 0.06);
      total = widths.reduce((a, b) => a + b, 0) / r;
      if (total <= maxAngle || size < 16) break;
      size -= 2;
    }
    let a = bottom ? centre + total / 2 : centre - total / 2;
    [...text].forEach((ch, i) => {
      const w = widths[i] / r;
      const mid = bottom ? a - w / 2 : a + w / 2;
      x.save();
      x.translate(cx + r * Math.cos(mid), cy + r * Math.sin(mid));
      x.rotate(bottom ? mid - Math.PI / 2 : mid + Math.PI / 2);
      x.fillText(ch, 0, 0);
      x.restore();
      a += bottom ? -w : w;
    });
  }

  PS.renderStamp = function (cfg) {
    const shape = DIMS[cfg.shape] ? cfg.shape : 'rect';
    const [W, H] = DIMS[shape];
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    const cx = W / 2, cy = H / 2;
    const bw = BW[cfg.border] || 10;
    const fam = FONTS[cfg.font] || FONTS.sans;
    x.fillStyle = x.strokeStyle = cfg.color || '#dc2626';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.lineJoin = 'round';

    const lines = String(cfg.text1 || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const dateStr = cfg.date
      ? new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase()
      : '';
    const mainParts = lines.map((t) => ({ text: t, rel: 1 }));

    if (shape === 'circle') {
      const R = W / 2 - bw / 2 - 4;
      ring(x, cx, cy, R, bw);
      ring(x, cx, cy, R - bw * 1.9, Math.max(3, bw / 3));
      const parts = [...mainParts];
      if (cfg.text2) parts.push({ text: cfg.text2, rel: 0.4 });
      if (dateStr) parts.push({ text: dateStr, rel: 0.34 });
      const inner = R - bw * 3.4;
      block(x, parts, cx, cy, inner * 1.5, inner * 1.2, fam);
    } else if (shape === 'seal') {
      const R1 = W / 2 - bw / 2 - 4;
      const R2 = R1 - 82;
      ring(x, cx, cy, R1, bw);
      ring(x, cx, cy, R2, Math.max(3, bw / 2.5));
      ring(x, cx, cy, R2 - 16, Math.max(2, bw / 4));
      const fs = 54;
      arcText(x, cfg.text2, cx, cy, R2 + 17, -Math.PI / 2, fs, fam, false, Math.PI * 0.82);
      arcText(x, cfg.text3, cx, cy, R1 - 16, Math.PI / 2, fs, fam, true, Math.PI * 0.82);
      star(x, cx - (R1 + R2) / 2, cy, 17);
      star(x, cx + (R1 + R2) / 2, cy, 17);
      const parts = [...mainParts];
      if (dateStr) parts.push({ text: dateStr, rel: 0.34 });
      const inner = R2 - 30;
      block(x, parts, cx, cy, inner * 1.55, inner * 1.25, fam);
    } else if (shape === 'oval') {
      const rx = W / 2 - bw / 2 - 4, ry = H / 2 - bw / 2 - 4;
      x.lineWidth = bw;
      x.beginPath(); x.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); x.stroke();
      x.lineWidth = Math.max(3, bw / 3);
      x.beginPath(); x.ellipse(cx, cy, rx - bw * 1.9, ry - bw * 1.9, 0, 0, Math.PI * 2); x.stroke();
      const parts = [...mainParts];
      if (cfg.text2) parts.push({ text: cfg.text2, rel: 0.38 });
      if (dateStr) parts.push({ text: dateStr, rel: 0.32 });
      block(x, parts, cx, cy, rx * 1.35, ry * 1.05, fam);
    } else {
      const m = bw / 2 + 4;
      const rad = shape === 'rounded' ? 80 : 26;
      x.lineWidth = bw;
      rrect(x, m, m, W - m * 2, H - m * 2, rad);
      x.stroke();
      if (shape === 'rect') {
        x.lineWidth = Math.max(3, bw / 3);
        rrect(x, m + bw * 1.7, m + bw * 1.7, W - (m + bw * 1.7) * 2, H - (m + bw * 1.7) * 2, Math.max(6, rad - bw * 1.7));
        x.stroke();
      }
      const parts = [...mainParts];
      if (cfg.text2) parts.push({ text: cfg.text2, rel: 0.38 });
      if (dateStr) parts.push({ text: dateStr, rel: 0.32 });
      block(x, parts, cx, cy, W - 140, H - 120, fam);
    }

    if (cfg.rubber) {
      const r = rng(cfg.seed || 7);
      x.save();
      x.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < 1500; i++) {
        x.globalAlpha = 0.3 + r() * 0.7;
        x.beginPath();
        x.arc(r() * W, r() * H, r() * r() * 7 + 0.6, 0, 6.283);
        x.fill();
      }
      x.globalAlpha = 0.55;
      x.lineCap = 'round';
      for (let i = 0; i < 26; i++) {
        x.lineWidth = 1 + r() * 2.5;
        const sx = r() * W, sy = r() * H, a = r() * 6.283, l = 20 + r() * 70;
        x.beginPath(); x.moveTo(sx, sy); x.lineTo(sx + Math.cos(a) * l, sy + Math.sin(a) * l); x.stroke();
      }
      x.restore();
    }
    return c;
  };
})();
