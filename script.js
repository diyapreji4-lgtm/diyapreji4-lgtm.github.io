(() => {
    'use strict';

    const wrap = document.getElementById('wrap');
    const canvas = document.getElementById('board');
    const ctx = canvas.getContext('2d');
    const fx = document.getElementById('fx');
    const fxc = fx.getContext('2d');
    const stage = document.querySelector('.stage');

    const toolButtons = [...document.querySelectorAll('.tool')];
    const colorInput = document.getElementById('color');
    const canvasColorInput = document.getElementById('canvasColor');
    const fillColorInput = document.getElementById('fillColor');
    const fillCheckbox = document.getElementById('fill');
    const sparkleCheckbox = document.getElementById('sparkles');
    const sparkleAmountInput = document.getElementById('sparkleAmount');
    const sparkleValue = document.getElementById('sparkleValue');
    const sizeInput = document.getElementById('size');
    const sizeValue = document.getElementById('sizeValue');
    const swatchWrap = document.getElementById('swatches');
    const undoBtn = document.getElementById('undo');
    const redoBtn = document.getElementById('redo');
    const clearBtn = document.getElementById('clear');
    const saveBtn = document.getElementById('save');
    const status = document.getElementById('status');
    const coords = document.getElementById('coords');

    const DOC_W = 1600;
    const DOC_H = 1000;

    const PALETTE = [
        '#1e293b', '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16',
        '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6', '#6366f1', '#a855f7',
        '#ec4899', '#f43f5e', '#78716c', '#ffffff', '#000000', '#94a3b8'
    ];

    const LABELS = {
        pencil: 'Pencil', line: 'Line', rect: 'Rectangle', ellipse: 'Ellipse',
        triangle: 'Triangle', star: 'Star', bucket: 'Fill', eraser: 'Eraser'
    };

    const FILL_TOLERANCE = 40;

    let tool = 'pencil';
    let color = colorInput.value;
    let canvasBg = canvasColorInput.value;
    let fillColor = fillColorInput.value;
    let size = Number(sizeInput.value);
    let useFill = false;
    let sparklesOn = sparkleCheckbox.checked;

    let drawing = false;
    let current = null;
    let start = null;
    let cursor = null;
    let lastSpawn = null;

    let base = 1;
    let lastCssW = -1;
    let lastCssH = -1;

    let history = [[]];
    let index = 0;

    function hexToRgb(hex) {
        let h = String(hex).replace('#', '');
        if (h.length === 3) h = h.split('').map(c => c + c).join('');
        const n = parseInt(h, 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }

    function shade(hex, amt) {
        const [r, g, b] = hexToRgb(hex);
        const target = amt > 0 ? 255 : 0;
        const k = Math.abs(amt);
        const f = v => Math.round(v + (target - v) * k);
        return `rgb(${f(r)},${f(g)},${f(b)})`;
    }

    function relLum(hex) {
        const [r, g, b] = hexToRgb(hex).map(v => {
            v /= 255;
            return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }

    function contrastRatio(a, b) {
        const l1 = relLum(a);
        const l2 = relLum(b);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    }

    function resizeCanvas() {
        const dpr = window.devicePixelRatio || 1;
        const availW = Math.max(200, stage.clientWidth - 32);
        const availH = Math.max(150, stage.clientHeight - 32);
        const scale = Math.min(availW / DOC_W, availH / DOC_H);

        const cssW = Math.max(1, Math.floor(DOC_W * scale));
        const cssH = Math.max(1, Math.floor(DOC_H * scale));
        const devW = Math.round(DOC_W * dpr);
        const devH = Math.round(DOC_H * dpr);

        const cssChanged = cssW !== lastCssW || cssH !== lastCssH;
        const devChanged = canvas.width !== devW || canvas.height !== devH;
        if (!cssChanged && !devChanged) return;

        lastCssW = cssW;
        lastCssH = cssH;
        base = devW / DOC_W;

        wrap.style.width = cssW + 'px';
        wrap.style.height = cssH + 'px';
        canvas.style.width = cssW + 'px';
        canvas.style.height = cssH + 'px';
        fx.style.width = cssW + 'px';
        fx.style.height = cssH + 'px';

        if (devChanged) {
            canvas.width = devW;
            canvas.height = devH;
            fx.width = devW;
            fx.height = devH;
        }
        redraw();
    }

    function starPath(c, x1, y1, x2, y2, points = 5) {
        const cx = (x1 + x2) / 2;
        const cy = (y1 + y2) / 2;
        const rx = Math.abs(x2 - x1) / 2;
        const ry = Math.abs(y2 - y1) / 2;
        c.beginPath();
        for (let i = 0; i < points * 2; i++) {
            const r = i % 2 === 0 ? 1 : 0.42;
            const a = -Math.PI / 2 + (i * Math.PI) / points;
            const px = cx + Math.cos(a) * rx * r;
            const py = cy + Math.sin(a) * ry * r;
            if (i === 0) c.moveTo(px, py);
            else c.lineTo(px, py);
        }
        c.closePath();
    }

    function smoothPath(c, pts) {
        c.beginPath();
        if (pts.length === 1) {
            c.arc(pts[0].x, pts[0].y, Math.max(c.lineWidth / 2, 0.5), 0, Math.PI * 2);
            return;
        }
        c.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length - 1; i++) {
            const mx = (pts[i].x + pts[i + 1].x) / 2;
            const my = (pts[i].y + pts[i + 1].y) / 2;
            c.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
        }
        const last = pts[pts.length - 1];
        c.lineTo(last.x, last.y);
    }

    function styleFor(c, item, erase) {
        c.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
        c.lineWidth = item.size;
        c.strokeStyle = erase ? '#000' : item.color;
        c.fillStyle = item.fillColor;
        c.lineJoin = 'round';
        c.lineCap = 'round';
    }

    function paint(c, item) {
        const erase = item.tool === 'eraser';
        styleFor(c, item, erase);

        switch (item.tool) {
            case 'pencil':
            case 'eraser':
                smoothPath(c, item.points);
                if (item.points.length === 1) c.fill();
                else c.stroke();
                break;

            case 'line':
                c.beginPath();
                c.moveTo(item.x1, item.y1);
                c.lineTo(item.x2, item.y2);
                c.stroke();
                break;

            case 'rect':
                c.beginPath();
                c.rect(
                    Math.min(item.x1, item.x2), Math.min(item.y1, item.y2),
                    Math.abs(item.x2 - item.x1), Math.abs(item.y2 - item.y1)
                );
                if (item.fill) c.fill();
                c.stroke();
                break;

            case 'ellipse':
                c.beginPath();
                c.ellipse(
                    (item.x1 + item.x2) / 2, (item.y1 + item.y2) / 2,
                    Math.abs(item.x2 - item.x1) / 2, Math.abs(item.y2 - item.y1) / 2,
                    0, 0, Math.PI * 2
                );
                if (item.fill) c.fill();
                c.stroke();
                break;

            case 'triangle':
                c.beginPath();
                c.moveTo((item.x1 + item.x2) / 2, item.y1);
                c.lineTo(item.x2, item.y2);
                c.lineTo(item.x1, item.y2);
                c.closePath();
                if (item.fill) c.fill();
                c.stroke();
                break;

            case 'star':
                starPath(c, item.x1, item.y1, item.x2, item.y2);
                if (item.fill) c.fill();
                c.stroke();
                break;
        }

        c.globalCompositeOperation = 'source-over';
    }

    function paintBitmap(c, item) {
        const t = c.getTransform();
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.putImageData(item.data, item.x, item.y);
        c.setTransform(t);
    }

    function redraw() {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(base, 0, 0, base, 0, 0);

        for (const item of history[index]) {
            if (item.tool === 'bitmap') paintBitmap(ctx, item);
            else paint(ctx, item);
        }
        if (current) paint(ctx, current);
    }

    function floodFill(lx, ly, hex) {
        const w = canvas.width;
        const h = canvas.height;
        const sx = Math.round(lx * base);
        const sy = Math.round(ly * base);
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null;

        const img = ctx.getImageData(0, 0, w, h);
        const d = img.data;
        const si = (sy * w + sx) * 4;

        const tr = d[si], tg = d[si + 1], tb = d[si + 2], ta = d[si + 3];
        const [fr, fg, fb] = hexToRgb(hex);

        if (Math.abs(tr - fr) <= 2 && Math.abs(tg - fg) <= 2 &&
            Math.abs(tb - fb) <= 2 && ta === 255) {
            return null;
        }

        const tol = FILL_TOLERANCE;
        const match = (i) =>
            Math.abs(d[i] - tr) <= tol && Math.abs(d[i + 1] - tg) <= tol &&
            Math.abs(d[i + 2] - tb) <= tol && Math.abs(d[i + 3] - ta) <= tol;

        let minX = sx, maxX = sx, minY = sy, maxY = sy;
        const stack = [sx, sy];
        while (stack.length) {
            const y = stack.pop();
            const x0 = stack.pop();
            const rowStart = y * w;
            if (!match((rowStart + x0) * 4)) continue;

            let left = x0;
            while (left > 0 && match((rowStart + left - 1) * 4)) left--;
            let right = x0;
            while (right < w - 1 && match((rowStart + right + 1) * 4)) right++;

            for (let x = left; x <= right; x++) {
                const i = (rowStart + x) * 4;
                d[i] = fr; d[i + 1] = fg; d[i + 2] = fb; d[i + 3] = 255;
            }

            if (left < minX) minX = left;
            if (right > maxX) maxX = right;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;

            for (const ny of [y - 1, y + 1]) {
                if (ny < 0 || ny >= h) continue;
                const nStart = ny * w;
                let inRun = false;
                for (let x = left; x <= right; x++) {
                    const hit = match((nStart + x) * 4);
                    if (hit && !inRun) {
                        stack.push(x, ny);
                        inRun = true;
                    } else if (!hit) {
                        inRun = false;
                    }
                }
            }
        }

        const rw = maxX - minX + 1;
        const rh = maxY - minY + 1;
        const out = new ImageData(rw, rh);
        for (let row = 0; row < rh; row++) {
            const from = ((minY + row) * w + minX) * 4;
            out.data.set(d.subarray(from, from + rw * 4), row * rw * 4);
        }

        return { tool: 'bitmap', x: minX, y: minY, data: out };
    }

    const TINTS_ON_DARK = ['#ffffff', '#fde68a', '#c7d2fe', '#a5f3fc', '#fbcfe8', '#fef08a'];
    const TINTS_ON_LIGHT = ['#6366f1', '#f59e0b', '#ec4899', '#06b6d4', '#a855f7', '#ef4444'];
    let particles = [];
    let fxRaf = 0;
    let lastFrame = 0;
    let trickle = 0;
    let sparkleAmount = Number(sparkleAmountInput.value);
    let sparkleTints = TINTS_ON_DARK;

    function maxParticles() {
        return 70 + sparkleAmount * 43;
    }

    function pickSparkleTints() {
        const score = (set) =>
            Math.min(...set.map(c => contrastRatio(c, canvasBg)));
        sparkleTints = score(TINTS_ON_DARK) >= score(TINTS_ON_LIGHT) ? TINTS_ON_DARK : TINTS_ON_LIGHT;
    }

    function sparkleColor() {
        if (Math.random() < 0.55) {
            return sparkleTints[(Math.random() * sparkleTints.length) | 0];
        }
        return sparkleTints === TINTS_ON_DARK ? shade(color, 0.35) : shade(color, -0.2);
    }

    function spawnSparkle(x, y, o) {
        o = o || {};
        if (particles.length >= maxParticles()) return;

        const life = o.life === undefined ? 260 + Math.random() * 300 : o.life;
        const spread = o.spread === undefined ? 2 : o.spread;
        const drift = o.drift === undefined ? 0.014 : o.drift;

        particles.push({
            x: x + (Math.random() - 0.5) * spread * 2,
            y: y + (Math.random() - 0.5) * spread * 2,
            vx: (Math.random() - 0.5) * drift,
            vy: (Math.random() - 0.5) * drift - 0.01,
            life, max: life,
            size: (o.size === undefined ? 5 : o.size) *
                  (0.6 + Math.random() * 0.7) *
                  (0.85 + sparkleAmount * 0.06),
            rot: Math.random() * Math.PI * 2,
            spin: (Math.random() - 0.5) * 0.004,
            color: o.color || sparkleColor()
        });
    }

    function burst(x, y, base) {
        const n = Math.max(4, Math.round(base * (0.5 + sparkleAmount / 8)));
        for (let i = 0; i < n; i++) {
            spawnSparkle(x, y, {
                spread: 3,
                drift: 0.05,
                life: 360 + Math.random() * 340,
                size: 5
            });
        }
        kickFx();
    }

    function spawnTrail() {
        if (!cursor) return;
        const count = 1 + Math.round(sparkleAmount / 4);
        for (let i = 0; i < count; i++) {
            spawnSparkle(cursor.x, cursor.y, {
                spread: 1.5 + sparkleAmount * 0.12,
                size: 4 + sparkleAmount * 0.25
            });
        }
    }

    function drawSparkle(c, p) {
        const k = p.life / p.max;
        const tw = 0.55 + 0.45 * Math.sin((1 - k) * 13 + p.rot * 3);
        const s = p.size * (0.3 + 0.7 * k) * tw;
        if (s <= 0.2) return;

        c.save();
        c.translate(p.x, p.y);
        c.rotate(p.rot);
        c.globalAlpha = Math.min(1, k * 1.7);
        c.fillStyle = p.color;
        c.beginPath();
        c.moveTo(0, -s);
        c.quadraticCurveTo(0, 0, s, 0);
        c.quadraticCurveTo(0, 0, 0, s);
        c.quadraticCurveTo(0, 0, -s, 0);
        c.quadraticCurveTo(0, 0, 0, -s);
        c.fill();
        c.restore();
    }

    function fxFrame(now) {
        const dt = lastFrame ? Math.min(40, now - lastFrame) : 16;
        lastFrame = now;

        if (drawing && sparklesOn && cursor) {
            trickle += dt;
            const interval = Math.max(16, 78 - sparkleAmount * 6);
            while (trickle > interval) { trickle -= interval; spawnTrail(); }
        } else {
            trickle = 0;
        }

        fxc.setTransform(1, 0, 0, 1, 0, 0);
        fxc.clearRect(0, 0, fx.width, fx.height);
        fxc.setTransform(base, 0, 0, base, 0, 0);
        fxc.globalCompositeOperation = 'lighter';

        for (let i = particles.length - 1; i >= 0; i--) {
            const p = particles[i];
            p.life -= dt;
            if (p.life <= 0 || p.x < -60 || p.x > DOC_W + 60 ||
                p.y < -60 || p.y > DOC_H + 60) {
                particles.splice(i, 1);
                continue;
            }
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.vy += 0.00002 * dt;
            p.rot += p.spin * dt;
            drawSparkle(fxc, p);
        }

        fxc.globalCompositeOperation = 'source-over';

        if (particles.length || (drawing && sparklesOn)) {
            fxRaf = requestAnimationFrame(fxFrame);
        } else {
            fxRaf = 0;
            lastFrame = 0;
        }
    }

    function kickFx() {
        if (!fxRaf) {
            lastFrame = 0;
            fxRaf = requestAnimationFrame(fxFrame);
        }
    }

    function stopFx() {
        if (fxRaf) cancelAnimationFrame(fxRaf);
        fxRaf = 0;
        lastFrame = 0;
        particles = [];
        fxc.setTransform(1, 0, 0, 1, 0, 0);
        fxc.clearRect(0, 0, fx.width, fx.height);
    }

    function clone(o) {
        return JSON.parse(JSON.stringify(o));
    }

    function push(snapshot) {
        history = history.slice(0, index + 1);
        history.push(snapshot);
        index = history.length - 1;
        if (history.length > 120) {
            history.shift();
            index--;
        }
        syncButtons();
        redraw();
    }

    function commit(item) {
        const stored = item.tool === 'bitmap' ? item : clone(item);
        push(history[index].concat(stored));
    }

    function undo() {
        if (index === 0) return;
        index--;
        redraw();
        syncButtons();
    }

    function redo() {
        if (index >= history.length - 1) return;
        index++;
        redraw();
        syncButtons();
    }

    function clearCanvas() {
        if (history[index].length === 0 && !current) return;
        stopFx();
        push([]);
    }

    function syncButtons() {
        undoBtn.disabled = index === 0;
        redoBtn.disabled = index >= history.length - 1;
    }

    function pointFrom(e) {
        const r = canvas.getBoundingClientRect();
        return {
            x: ((e.clientX - r.left) / r.width) * DOC_W,
            y: ((e.clientY - r.top) / r.height) * DOC_H
        };
    }

    function baseItem() {
        return {
            tool,
            size,
            color,
            fillColor,
            fill: useFill && tool !== 'line' && tool !== 'pencil' && tool !== 'eraser'
        };
    }

    function constrain(item, shift) {
        if (!shift || !start) return item;
        if (item.tool === 'rect' || item.tool === 'ellipse') {
            const side = Math.max(Math.abs(item.x2 - item.x1), Math.abs(item.y2 - item.y1));
            item.x2 = item.x1 + Math.sign(item.x2 - item.x1 || 1) * side;
            item.y2 = item.y1 + Math.sign(item.y2 - item.y1 || 1) * side;
        } else if (item.tool === 'line') {
            const dx = item.x2 - item.x1;
            const dy = item.y2 - item.y1;
            const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
            const len = Math.hypot(dx, dy);
            item.x2 = item.x1 + Math.cos(a) * len;
            item.y2 = item.y1 + Math.sin(a) * len;
        }
        return item;
    }

    canvas.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        canvas.setPointerCapture(e.pointerId);
        const p = pointFrom(e);
        cursor = p;
        lastSpawn = p;

        if (tool === 'bucket') {
            const item = floodFill(p.x, p.y, color);
            if (item) {
                commit(item);
                if (sparklesOn) burst(p.x, p.y, 16);
            }
            return;
        }

        drawing = true;
        start = p;

        if (tool === 'pencil' || tool === 'eraser') {
            current = Object.assign(baseItem(), { points: [p] });
        } else {
            current = Object.assign(baseItem(), { x1: p.x, y1: p.y, x2: p.x, y2: p.y });
        }

        if (sparklesOn) {
            spawnTrail();
            spawnTrail();
            kickFx();
        }
        redraw();
    });

    canvas.addEventListener('pointermove', (e) => {
        const p = pointFrom(e);
        cursor = p;
        coords.textContent = `${Math.round(p.x)}, ${Math.round(p.y)}`;

        if (drawing && sparklesOn) {
            const step = Math.max(3, 12 - sparkleAmount);
            const moved = lastSpawn ? Math.hypot(p.x - lastSpawn.x, p.y - lastSpawn.y) : 99;
            if (moved > step) {
                lastSpawn = p;
                spawnTrail();
                kickFx();
            }
        }

        if (!drawing || !current) return;

        if (current.points) {
            current.points.push(p);
        } else {
            current.x2 = p.x;
            current.y2 = p.y;
            constrain(current, e.shiftKey);
        }
        redraw();
    });

    function endStroke() {
        if (!drawing) return;
        drawing = false;
        if (current) {
            const tiny = current.points
                ? false
                : Math.hypot(current.x2 - current.x1, current.y2 - current.y1) < 4;
            if (!tiny) {
                const end = current.points ? current.points[current.points.length - 1] : current;
                if (sparklesOn) burst(end.x, end.y, 8);
                commit(current);
            }
        }
        current = null;
        start = null;
        redraw();
    }

    canvas.addEventListener('pointerup', endStroke);
    canvas.addEventListener('pointercancel', endStroke);

    function selectTool(name) {
        tool = name;
        toolButtons.forEach(b => b.classList.toggle('active', b.dataset.tool === name));
        status.textContent = LABELS[name] || name;
        canvas.style.cursor = name === 'eraser' ? 'cell' : name === 'bucket' ? 'copy' : 'crosshair';
    }

    toolButtons.forEach(btn => {
        btn.addEventListener('click', () => selectTool(btn.dataset.tool));
    });

    colorInput.addEventListener('input', () => { color = colorInput.value; markSwatch(); });

    canvasColorInput.addEventListener('input', () => {
        canvasBg = canvasColorInput.value;
        wrap.style.background = canvasBg;
        pickSparkleTints();
    });

    fillColorInput.addEventListener('input', () => { fillColor = fillColorInput.value; });
    fillCheckbox.addEventListener('change', () => { useFill = fillCheckbox.checked; });

    sparkleCheckbox.addEventListener('change', () => {
        sparklesOn = sparkleCheckbox.checked;
        sparkleAmountInput.disabled = !sparklesOn;
        if (sparklesOn) kickFx();
        else stopFx();
    });

    sparkleAmountInput.addEventListener('input', () => {
        sparkleAmount = Number(sparkleAmountInput.value);
        sparkleValue.textContent = sparkleAmount;
    });

    sizeInput.addEventListener('input', () => {
        size = Number(sizeInput.value);
        sizeValue.textContent = size;
    });

    PALETTE.forEach(c => {
        const b = document.createElement('button');
        b.className = 'swatch';
        b.style.background = c;
        b.title = c;
        b.dataset.color = c;
        b.addEventListener('click', () => {
            color = c;
            colorInput.value = c;
            markSwatch();
        });
        swatchWrap.appendChild(b);
    });

    function markSwatch() {
        [...swatchWrap.children].forEach(s => {
            s.classList.toggle('active', s.dataset.color.toLowerCase() === color.toLowerCase());
        });
    }

    undoBtn.addEventListener('click', undo);
    redoBtn.addEventListener('click', redo);
    clearBtn.addEventListener('click', clearCanvas);

    saveBtn.addEventListener('click', () => {
        const out = document.createElement('canvas');
        out.width = canvas.width;
        out.height = canvas.height;
        const octx = out.getContext('2d');
        octx.fillStyle = canvasBg;
        octx.fillRect(0, 0, out.width, out.height);
        octx.drawImage(canvas, 0, 0);

        const a = document.createElement('a');
        a.download = `diya-${Date.now()}.png`;
        a.href = out.toDataURL('image/png');
        a.click();
    });

    document.addEventListener('keydown', (e) => {
        const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
        const mod = e.ctrlKey || e.metaKey;

        if (mod && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            e.shiftKey ? redo() : undo();
            return;
        }
        if (mod && e.key.toLowerCase() === 'y') {
            e.preventDefault();
            redo();
            return;
        }
        if (mod && e.key.toLowerCase() === 's') {
            e.preventDefault();
            saveBtn.click();
            return;
        }
        if (mod || typing) return;

        const map = {
            p: 'pencil', l: 'line', r: 'rect', e: 'ellipse',
            t: 'triangle', s: 'star', f: 'bucket', g: 'bucket', x: 'eraser'
        };
        const picked = map[e.key.toLowerCase()];
        if (picked) selectTool(picked);
    });

    new ResizeObserver(resizeCanvas).observe(stage);
    wrap.style.background = canvasBg;
    pickSparkleTints();
    selectTool('pencil');
    markSwatch();
    syncButtons();
    resizeCanvas();
})();
