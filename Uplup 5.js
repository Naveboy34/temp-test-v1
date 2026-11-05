(() => {
    'use strict';
    const $ = id => document.getElementById(id), U = 256, MAX_TILES = 40000, MAX_OBJECTS = 400, MAX_BYTES = 2000000;
    const TYPES = {
        SpikeBall: 'Spike ball', SpikePlatform: 'Spiked moving platform', MovingPlatform: 'Moving platform', Bouncer: 'Bouncer', PopSpike: 'Pop-out spike', TrapSpike: 'Triggered spike', Thwomp: 'Thwomp', Stalactite: 'Stalactite', Key: 'Key', Lock: 'Key block / Lock', Portal: 'Portal'
    };
    const LOOP_TYPES = new Set(['SpikeBall', 'SpikePlatform', 'MovingPlatform', 'PopSpike']);
    // Observed in-game speed control: eight steps. Period is half the travel cycle in frames.
    // 1 ≈ 240 frames A→B, 8 ≈ 30 frames A→B (60 FPS model).
    const SPEED_PERIODS = [240, 120, 80, 60, 48, 40, 34, 30], PHASE_STEPS = 16;
    let previewPlaying = false, previewPct = 0, previewLast = 0, previewTick = 0, previewSelected = -1;
    const COLORS = {
        '#': '#657284', '~': '#6bbfe0', '^': '#d7596a', '.': '#0d1421', 'D': '#e9b968'
    };
    const canvas = $('mapCanvas'), ctx = canvas.getContext('2d'), stage = $('stage');
    let cw = 0, ch = 0, dpr = 1, zoom = 10, ox = 0, oy = 0, currentTool = 'brush', material = '#', selected = -1, drag = null, hover = null, dirty = false;
    let state = null, undo = [], redo = [];
    const MAX_UNDO = 40;

    function validNum(id, def) {
        /* Tries to read a value from an HTML ID, otherwise uses a default value */
        let x = Number($(id).value);
        return Number.isFinite(x) ? x : def;
    }

    function setStatus(status) {
        /* Sets the message in the bottom right */
        $('stageTip').textContent = status;
    }

    function jsonDeepCopy(json) {
        /* Deep json copy */
        return JSON.parse(JSON.stringify(json));
    }

    function validateLevelName(name) {
        /* Replaces illegal characters in the level name with underscores */
        return (name || 'My Jono Level').trim().replace(/[\\/<>:"|?*\x00-\x1f]+/g, '_').replace(/\.+$/, '').slice(0, 100) || 'My Jono Level';
    }

    function validateLevelDimensions() {
        /* Ensures that the level's size stays within limits */
        const w = Math.floor(validNum('mapWidth', 80)), h = Math.floor(validNum('mapHeight', 48));
        if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w < 4 || h < 4 || w * h > MAX_TILES) {
            alert('Map width and height must each be at least 4, and width × height must be 40,000 tiles or fewer.');
            return null;
        }
        return [w, h];
    }

    function generateRows(w, h, style) {
        /* Generates a new level row-by-row based on the style argument */
        let result = [];
        for (let row = 0; row < h; row++) {
            if (style === 'rock')
                result.push('#'.repeat(w));
            else if (style === 'ice')
                result.push('~'.repeat(w));
            else if (style === 'air')
                result.push('.'.repeat(w));
            else if (row === 0 || row === h - 1)
                result.push('#'.repeat(w));
            else
                result.push('#' + '.'.repeat(w - 2) + '#');
        }

        return result;
    }

    function createLevel(w, h, style) {
        /* Creates a new json level from a template (style) */
        const tiles = generateRows(w, h, style);
        const spawnX = 2, spawnY = h - 2;
        const d = { width: w, height: h, spawnX: spawnX, spawnY: spawnY, period: 120, tiles, entities: [], mode: 'grinder', theme: 8 };
        return d;
    }

    function snapShot() {
        /* Copies the current state of the level into the undo queue */
        undo.push(JSON.stringify(state));
        if (undo.length > MAX_UNDO)
            undo.shift();
        redo = [];
        dirty = true;
        updateUndoButtons();
    }

    function updateUndoButtons() {
        /* Disables the undo and redo buttons if there's nothing to undo or redo, respectively */
        $('undoBtn').disabled = (undo.length == 0);
        $('redoBtn').disabled = (redo.length == 0);
    }

    function restore(json, resethistory = false, wantFit = false) {
        /* Restores the level to some other state */

        try { state = JSON.parse(json); }
        catch { state = json; }
        selected = -1;
        previewPlaying = false;
        previewPct = 0;

        syncFields();
        if (resethistory)
            resetHistory();
        if (wantFit)
            fit();
        updateAll();
    }

    function undoAction() {
        /* Undo functionality */
        if (undo.length == 0)
            return;

        redo.push(JSON.stringify(state));
        restore(undo.pop());
        updateUndoButtons();
        setStatus('Undid last change');
    }

    function redoAction() {
        /* Redo Functionality */
        if (redo.length == 0)
            return;

        undo.push(JSON.stringify(state));
        restore(redo.pop());
        updateUndoButtons();
        setStatus('Redid last change');
    }

    function resetHistory() {
        /* Removes all undo and redo history */
        undo = [];
        redo = [];
        dirty = false;
        updateUndoButtons();
    }

    function syncFields() {
        /* Sets the below values to what's listed in the current level state */
        $('mapWidth').value = state.width;
        $('mapHeight').value = state.height;
        $('spawnX').value = state.spawnX;
        $('spawnY').value = state.spawnY;
        $('mapPeriod').value = state.period ?? 120;
        $('mapTheme').value = state.theme ?? '';
    }

    function resizeLevel() {
        /* Functionality for the resize button. Resizing done by keeping the top left corner intact */
        const dims = validateLevelDimensions();
        if (!dims)
            return;

        let [w, h] = dims;
        if (w == state.width && h == state.height) {
            setStatus('Map dimensions are unchanged');
            return;
        }

        const fill = $('fillStyle').value;
        const oldTiles = state.tiles;
        snapShot();

        /* Generates new tiles and overwrites them with the old data */
        const newTiles = generateRows(w, h, fill).map(r => r.split(''));
        for (let y = 0; y < Math.min(h, state.height); y++)
            for (let x = 0; x < Math.min(w, state.width); x++)
                newTiles[y][x] = oldTiles[y][x];

        state.width = w;
        state.height = h;
        state.spawnX = Math.min(state.spawnX, w - 1);
        state.spawnY = Math.min(state.spawnY, h - 1);
        state.tiles = newTiles.map(r => r.join(''));
        fit();
        updateAll();
        setStatus('Resized');
    }

    function tile(x, y) {
        /* Returns the tile type at a location */
        if (x < 0 || y < 0 || x >= state.width || y >= state.height)
            return null;
        return state.tiles[y][x];
    }

    function placeTile(x, y, mat) {
        /* Places tiles */
        x = Math.floor(x);
        y = Math.floor(y);

        if (x < 0 || y < 0 || x >= state.width || y >= state.height || state.tiles[y][x] == mat)
            return false

        state.tiles[y] = state.tiles[y].slice(0, x) + mat + state.tiles[y].slice(x + 1);
        return true;
    }

    function brush(x, y, mat, brushSize) {
        /* Functionality for the brush tool. Places tiles in a square with side length brushSize */
        const shortSide = Math.floor((brushSize - 1) / 2);
        const longSide = Math.ceil((brushSize - 1) / 2);

        for (let yPos = y - shortSide; yPos <= y + longSide; yPos++)
            for (let xPos = x - shortSide; xPos <= x + longSide; xPos++)
                placeTile(xPos, yPos, mat)
    }

    function drawLine(x1, y1, x2, y2, mat, brushSize) {
        /* Draws a line between (x1, y1) and (x2, y2). Uses Bresenham's algorithm */
        let dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1)
        let stepX = x1 < x2 ? 1 : -1, stepY = y1 < y2 ? 1 : -1
        let err = dx - dy;

        while (true) {
            console.log(err)
            brush(x1, y1, mat, brushSize);
            if (x1 == x2 && y1 == y2)
                break;

            let ee = 2 * err;
            if (ee > -dy) {
                err -= dy;
                x1 += stepX;
            }
            if (ee < dx) {
                err += dx;
                y1 += stepY;
            }
        }
    }

    function drawRectTiles(x1, y1, x2, y2, c, outline) {
        const a = Math.max(0, Math.min(x1, x2)), b = Math.min(state.width - 1, Math.max(x1, x2)), top = Math.max(0, Math.min(y1, y2)), bottom = Math.min(state.height - 1, Math.max(y1, y2)); for (let y = top; y <= bottom; y++)
            for (let x = a; x <= b; x++)
                if (!outline || y === top || y === bottom || x === a || x === b)
                    placeTile(x, y, c);
    }

    function fillRegion(x, y, c) {
        const before = tile(x, y); if (before === null || before === c)
            return 0; const w = state.width, h = state.height, chars = state.tiles.map(r => r.split('')), queue = [[x, y]]; let head = 0, count = 0; chars[y][x] = c; while (head < queue.length) {
                let [xx, yy] = queue[head++];
                count++;
                for (const [nx, ny] of [[xx - 1, yy], [xx + 1, yy], [xx, yy - 1], [xx, yy + 1]]) {
                    if (nx < 0 || nx >= w || ny < 0 || ny >= h || chars[ny][nx] !== before)
                        continue;
                    chars[ny][nx] = c;
                    queue.push([nx, ny]);
                }
            } state.tiles = chars.map(r => r.join('')); return count;
    }

    function placeDoor(x, y) {
        if (x < 0 || x >= state.width || y < 0 || y >= state.height - 1) {
            setStatus('Door needs two vertically adjacent tiles inside the map');
            return;
        } snapShot(); for (let yy = 0; yy < state.height; yy++)
            if (state.tiles[yy].includes('D'))
                state.tiles[yy] = state.tiles[yy].replaceAll('D', '.'); placeTile(x, y, 'D'); placeTile(x, y + 1, 'D'); updateAll();
    }

    function kind(e) { return e.kind || 'MovingPlatform'; }

    function addEntityAt(type, x, y) {
        if (countThings() >= MAX_OBJECTS) {
            alert('This level already has 400 things including imported dialogue regions. Remove some before adding another.');
            return;
        }

        if (x < 0 || y < 0 || x >= state.width || y >= state.height)
            return;

        snapShot();
        const ent = objectNew(type, Math.floor(x), Math.floor(y));
        state.entities.push(ent);
        chooseSelection(state.entities.length - 1);
        updateAll();
    }

    function objectNew(type, x, y) {
        const px = Math.round(x * U), py = Math.round(y * U), id = nextTrapId();
        let ent = { kind: type, x0: px, y0: py, x1: px, y1: py, w: U, h: U, period: 1, trap: -1, needs: -1 };
        switch (type) {
            case 'platform':
                delete ent.kind;
                ent.w = U * 2;
                ent.period = 120;
                ent.x1 = px + U * 3;
                ent.phase = 0;
                break;
            case 'spikeball':
                ent.w = 224;
                ent.h = 224;
                ent.period = 120;
                ent.phase = 0;
                break;
            case 'spikeplatform':
                ent.w = U * 3;
                ent.period = 120;
                ent.x1 = px + U * 3;
                ent.phase = 0;
                break;
            case 'bouncer':
                ent.h = 96;
                break;
            case 'popspike':
                ent.x1 = px + U;
                ent.period = 240;
                ent.phase = 0;
                break;
            case 'portal':
                ent.x1 = px + U * 6;
                ent.period = 1;
                ent.phase = 0;
                break;
            case 'trapspike':
                ent.y1 = py - U;
                ent.trap = id;
                ent.trigX = px;
                ent.trigY = py - U;
                ent.trigW = U;
                ent.trigH = U;
                break;
            case 'thwomp':
                ent.h = U * 2;
                ent.y1 = py + U * 4;
                ent.trap = id;
                ent.trigX = px;
                ent.trigY = py + U * 2;
                ent.trigW = U;
                ent.trigH = U * 4;
                break;
            case 'stalactite':
                ent.y1 = py + U * 4;
                ent.trap = id;
                ent.trigX = px - 64;
                ent.trigY = py + U;
                ent.trigW = U + 128;
                ent.trigH = U * 4;
                break;
            case 'key':
                ent.trap = id;
                ent.trigX = px + 48;
                ent.trigY = py + 32;
                ent.trigW = 160;
                ent.trigH = 192;
                break;
            case 'lock':
                ent.trap = id;
                ent.needs = existingKeyId();
                ent.trigX = px - 16;
                ent.trigY = py - 16;
                ent.trigW = U + 32;
                ent.trigH = U + 32;
                break;
        }
        return ent;
    }

    function nextTrapId() {
        const s = new Set((state.entities || []).map(e => e.trap).filter(v => Number.isInteger(v) && v >= 0)); let i = 0; while (s.has(i))
            i++; return i;
    }

    function existingKeyId() { const found = state.entities.find(e => e.kind === 'Key' && e.trap >= 0); return found ? found.trap : -1; }

    function countThings() { return (state.entities?.length || 0) + (state.signs?.length || 0); }

    function updateObjPosition(i, dx, dy) {
        const e = state.entities[i]; e.x0 += dx; e.y0 += dy; e.x1 += dx; e.y1 += dy; if (Number.isFinite(e.trigX))
            e.trigX += dx; if (Number.isFinite(e.trigY))
            e.trigY += dy;
    }

    function changeTool(tool, type = 'tool') {
        currentTool = tool; /* Global variable */

        if (type == 'entity') {
            /* Select the entity button*/
            document.querySelectorAll('[data-ent]').forEach(b => b.classList.toggle('selected', b.dataset.ent === currentTool));

            /* Deselect non-entity buttons */
            document.querySelectorAll('[data-mat]').forEach(b => b.classList.remove('selected'));
            document.querySelectorAll('[data-tool]').forEach(b => b.classList.remove('active'));
        }

        else {
            /* Select the tool */
            document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === currentTool));

            /* Deselect entities */
            document.querySelectorAll('[data-ent]').forEach(b => b.classList.remove('selected'));

            /* Deselect materials if trying to place an entrace or exit door */
            if (['spawn', 'door'].includes(currentTool)) {
                /* Deselect materials and entities */
                document.querySelectorAll('[data-mat]').forEach(b => b.classList.remove('selected'));
            }

            /* Selects rock as the default material if selecting a tool when no material is selected */
            else if (document.querySelectorAll('[data-mat].selected').length === 0) {
                chooseMat('#');
            }
        }

        /* Set the cursor style */
        if (currentTool === 'pan') {
            canvas.style.cursor = 'grab';
        }
        else if (currentTool === 'select') {
            canvas.style.cursor = 'default';
        }
        else if (['door', 'spawn', 'start', 'end'].includes(currentTool) || type == 'entity') {
            canvas.style.cursor = 'copy';
        }
        else {
            canvas.style.cursor = 'crosshair';
        }

        /* Toggle the brushsize box on/off if brush, line, or eraser is selected */
        document.querySelectorAll('.brushSize').forEach(b => b.style.display = ['brush', 'line', 'eraser'].includes(currentTool) ? 'block' : 'none');
    }

    function chooseMat(mat) {
        material = mat;
        document.querySelectorAll('[data-mat]').forEach(b => b.classList.toggle('selected', b.dataset.mat === material));
        /* Sets the tool to brush if a material is selected with no tool */
        if (!['select', 'pan', 'brush', 'line', 'rectangle', 'fill', 'pick', 'eraser'].includes(currentTool))
            changeTool('brush'); render();
    }

    function fit() {
        if (!cw || !ch || !state)
            return;
        zoom = Math.max(.6, Math.min(32, Math.min((cw - 44) / state.width, (ch - 44) / state.height)));
        ox = (cw - state.width * zoom) / 2; oy = (ch - state.height * zoom) / 2;
        render();
    }

    function zoomAt(factor, sx = cw / 2, sy = ch / 2) { const wx = (sx - ox) / zoom, wy = (sy - oy) / zoom; zoom = Math.max(.5, Math.min(75, zoom * factor)); ox = sx - wx * zoom; oy = sy - wy * zoom; render(); }

    function sizeCanvas() { const r = stage.getBoundingClientRect(); cw = Math.max(1, r.width); ch = Math.max(1, r.height); dpr = Math.min(window.devicePixelRatio || 1, 2); canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr); canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px'; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); render(); }

    function pointerPos(ev) { const r = canvas.getBoundingClientRect(); const sx = ev.clientX - r.left, sy = ev.clientY - r.top, x = (sx - ox) / zoom, y = (sy - oy) / zoom; return { sx, sy, x, y, tx: Math.floor(x), ty: Math.floor(y) }; }

    function hasTile(p) { return p.tx >= 0 && p.ty >= 0 && p.tx < state.width && p.ty < state.height; }

    function drawTile(c, x, y, px, py, s) {
        if (c === '#') {
            ctx.fillStyle = COLORS[c];
            ctx.fillRect(px, py, s + .12, s + .12);
            if (s >= 10) {
                ctx.fillStyle = '#7b8997';
                ctx.fillRect(px + .6, py + .6, s - 1.2, Math.min(2, s * .12));
            }
        }
        else if (c === '~') {
            ctx.fillStyle = COLORS[c];
            ctx.fillRect(px, py, s + .12, s + .12);
            if (s >= 9) {
                ctx.fillStyle = '#a4eaf2';
                ctx.fillRect(px + s * .17, py + s * .15, s * .42, Math.max(1, s * .14));
                ctx.fillStyle = '#427d9d';
                ctx.fillRect(px + s * .62, py + s * .57, s * .17, s * .23);
            }
        }
        else if (c === '^') {
            ctx.fillStyle = '#ab3e50';
            ctx.fillRect(px, py + s * .55, s, s * .45);
            if (s >= 4) {
                ctx.fillStyle = '#f0848a';
                ctx.beginPath();
                ctx.moveTo(px, py + s * .64);
                ctx.lineTo(px + s * .5, py + s * .04);
                ctx.lineTo(px + s, py + s * .64);
                ctx.fill();
            }
            else {
                ctx.fillStyle = COLORS[c];
                ctx.fillRect(px, py, s, s);
            }
        }
        else if (c === 'D') {
            ctx.fillStyle = '#ddaa58';
            ctx.fillRect(px, py, s + .1, s + .1);
            if (s > 7) {
                ctx.fillStyle = '#785032';
                ctx.fillRect(px + s * .14, py + s * .08, s * .71, s * .85);
                ctx.fillStyle = '#ffe2a0';
                ctx.fillRect(px + s * .12, py + s * .08, s * .1, s * .8);
            }
        }
        else if (c !== '.') {
            ctx.fillStyle = '#b76af9';
            ctx.fillRect(px, py, s + .1, s + .1);
        }
    }

    function render() {
        if (!state || !cw || !ch)
            return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cw, ch);
        ctx.fillStyle = '#0b1420';
        ctx.fillRect(0, 0, cw, ch);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, cw, ch);
        ctx.clip();
        const x1 = Math.max(0, Math.floor(-ox / zoom)), y1 = Math.max(0, Math.floor(-oy / zoom)), x2 = Math.min(state.width - 1, Math.ceil((cw - ox) / zoom)), y2 = Math.min(state.height - 1, Math.ceil((ch - oy) / zoom));
        ctx.fillStyle = COLORS['.'];
        ctx.fillRect(ox, oy, state.width * zoom, state.height * zoom);
        for (let y = y1; y <= y2; y++) {
            const row = state.tiles[y];
            for (let x = x1; x <= x2; x++) {
                const c = row[x];
                if (c !== '.')
                    drawTile(c, x, y, ox + x * zoom, oy + y * zoom, zoom);
            }
        }
        if ($('gridCheck').checked && zoom >= 7) {
            ctx.strokeStyle = '#bcd0e61c';
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let x = x1; x <= x2 + 1; x++) {
                let xx = Math.round(ox + x * zoom) + .5;
                ctx.moveTo(xx, Math.max(0, oy));
                ctx.lineTo(xx, Math.min(ch, oy + state.height * zoom));
            }
            for (let y = y1; y <= y2 + 1; y++) {
                let yy = Math.round(oy + y * zoom) + .5;
                ctx.moveTo(Math.max(0, ox), yy);
                ctx.lineTo(Math.min(cw, ox + state.width * zoom), yy);
            }
            ctx.stroke();
        }
        // imported developer-only sign areas are displayed but not edited
        if ($('signCheck').checked && Array.isArray(state.signs)) {
            ctx.save();
            ctx.strokeStyle = '#f8b45e99';
            ctx.fillStyle = '#f8b45e17';
            ctx.lineWidth = 2;
            state.signs.forEach((a, i) => {
                ctx.fillRect(ox + a.x * zoom, oy + a.y * zoom, a.w * zoom, a.h * zoom); ctx.strokeRect(ox + a.x * zoom, oy + a.y * zoom, a.w * zoom, a.h * zoom); if (zoom > 3) {
                    ctx.font = 'bold 11px system-ui';
                    ctx.fillStyle = '#ffe5ad';
                    ctx.fillText(String(i + 1), ox + a.x * zoom + 3, oy + a.y * zoom + 12);
                    ctx.fillStyle = '#f8b45e17';
                }
            });
            ctx.restore();
        }
        if ($('objectCheck').checked) {
            state.entities.forEach((e, i) => {
                const ex = e.x0 / U, ey = e.y0 / U, ew = e.w / U, eh = e.h / U;
                const sx = ox + ex * zoom, sy = oy + ey * zoom;
                const xs = ew * zoom, ys = eh * zoom;
                if (sx + xs < 0 || sy + ys < 0 || sx > cw || sy > ch)
                    return;
                let k = kind(e), col = k === 'Key' ? '#ffdb73' : k === 'Lock' ? '#b38dff' : k === 'Portal' ? '#93a6ff' : k === 'Bouncer' ? '#75e3a0' : k === 'MovingPlatform' ? '#b5d1ed' : '#ff8390';
                if ($('pathCheck').checked && (e.x0 !== e.x1 || e.y0 !== e.y1)) {
                    ctx.strokeStyle = '#c5ddec91';
                    ctx.lineWidth = 1.5;
                    ctx.setLineDash([4, 4]);
                    ctx.beginPath();
                    ctx.moveTo(sx + xs / 2, sy + ys / 2);
                    ctx.lineTo(ox + (e.x1 + e.w / 2) / U * zoom, oy + (e.y1 + e.h / 2) / U * zoom);
                    ctx.stroke();
                    ctx.setLineDash([]);
                }
                ctx.fillStyle = k === 'SpikeBall' ? col + '69' : col + '42';
                ctx.fillRect(sx, sy, Math.max(xs, 4), Math.max(ys, 4));
                ctx.strokeStyle = i === selected ? '#fff9c5' : col;
                ctx.lineWidth = i === selected ? 2.6 : 1.5;
                ctx.strokeRect(sx, sy, Math.max(xs, 4), Math.max(ys, 4));
                if (Math.max(xs, ys) > 12) {
                    ctx.fillStyle = i === selected ? '#ffffff' : col;
                    ctx.font = 'bold 10px system-ui';
                    ctx.fillText(k === 'MovingPlatform' ? 'MP' : k === 'SpikeBall' ? 'SB' : k === 'SpikePlatform' ? 'SP' : k.slice(0, 2).toUpperCase(), sx + 3, sy + 12);
                }
            });
        }
        // Selected moving object: A/B handles and animated path preview. This never alters exported positions.
        if ($('motionCheck').checked && state.entities[selected] && LOOP_TYPES.has(kind(state.entities[selected])))
            drawMotionOverlay(state.entities[selected]);
        // spawn marker
        const spx = ox + (state.spawnX + .5) * zoom, spy = oy + (state.spawnY + .5) * zoom;
        ctx.fillStyle = '#8ff9c8';
        ctx.strokeStyle = '#11382e';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(spx, spy - 7);
        ctx.lineTo(spx + 7, spy);
        ctx.lineTo(spx, spy + 7);
        ctx.lineTo(spx - 7, spy);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // outline map
        ctx.strokeStyle = '#7d94b0';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(ox, oy, state.width * zoom, state.height * zoom);
        // tool preview
        if (drag && ['line', 'rect'].includes(drag.type)) {
            const a = drag.start, b = drag.current, c = material === '.' ? '#93a8bd' : COLORS[material] || '#fff';
            ctx.save();
            ctx.lineWidth = 2;
            ctx.strokeStyle = c;
            ctx.fillStyle = c + '38';
            ctx.setLineDash([5, 3]);
            if (drag.type === 'rect') {
                let x = Math.min(a.tx, b.tx), y = Math.min(a.ty, b.ty), w = Math.abs(b.tx - a.tx) + 1, h = Math.abs(b.ty - a.ty) + 1;
                ctx.fillRect(ox + x * zoom, oy + y * zoom, w * zoom, h * zoom);
                ctx.strokeRect(ox + x * zoom, oy + y * zoom, w * zoom, h * zoom);
            }
            else {
                ctx.beginPath();
                ctx.moveTo(ox + (a.tx + .5) * zoom, oy + (a.ty + .5) * zoom);
                ctx.lineTo(ox + (b.tx + .5) * zoom, oy + (b.ty + .5) * zoom);
                ctx.stroke();
            }
            ctx.restore();
        }
        if (hover && hasTile(hover) && !drag) {
            ctx.strokeStyle = '#eafff6b2';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(ox + hover.tx * zoom, oy + hover.ty * zoom, zoom, zoom);
        }
        ctx.restore();
        $('zoomLabel').textContent = Math.round(zoom * 100 / 10) + '%';
    }

    function phaseFraction(e) {
        let per = Math.max(1, Number(e.period) || 120), span = 2 * per, ph = Number(e.phase) || 0; if (ph > 0 && ph % span === 0)
            return 1; return ((ph % span) + span) % span / span;
    }

    function motionPosition(e, pct) {
        const per = Math.max(1, Number(e.period) || 120), span = 2 * per, frame = span * pct / 100 + (Number(e.phase) || 0); let progress = ((frame % span) + span) % span / per; if (progress > 1)
            progress = 2 - progress; return { x: e.x0 + (e.x1 - e.x0) * progress, y: e.y0 + (e.y1 - e.y0) * progress, progress };
    }

    function drawMotionOverlay(e) {
        const a = { x: ox + (e.x0 + e.w / 2) / U * zoom, y: oy + (e.y0 + e.h / 2) / U * zoom }, b = { x: ox + (e.x1 + e.w / 2) / U * zoom, y: oy + (e.y1 + e.h / 2) / U * zoom };
        ctx.save();
        ctx.strokeStyle = '#75eecb';
        ctx.lineWidth = 2.2;
        ctx.setLineDash([7, 4]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.setLineDash([]);
        const points = [['A', a, '#71e3b8'], ['B', b, '#f4c47f']];
        for (let [tag, p, color] of points) {
            ctx.fillStyle = color;
            ctx.strokeStyle = '#101c26';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(p.x, p.y, Math.max(5, Math.min(9, zoom * .38)), 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.font = 'bold 11px system-ui';
            ctx.fillStyle = '#071523';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(tag, p.x, p.y + 0.5);
        }
        const pt = motionPosition(e, previewPct);
        const sx = ox + pt.x / U * zoom, sy = oy + pt.y / U * zoom, ww = Math.max(4, e.w / U * zoom), hh = Math.max(4, e.h / U * zoom);
        ctx.fillStyle = '#80f6da40';
        ctx.strokeStyle = '#effffb';
        ctx.lineWidth = 2.3;
        ctx.fillRect(sx, sy, ww, hh);
        ctx.strokeRect(sx, sy, ww, hh);
        ctx.restore();
    }

    function updateMotionReadout() {
        const e = state?.entities?.[selected], read = $('motionNow'); if (!read || !e)
            return; const p = motionPosition(e, previewPct), percent = Math.round(p.progress * 100); read.textContent = `Preview position: ${(p.x / U).toFixed(2)}, ${(p.y / U).toFixed(2)} tiles · ${percent}% A→B`;
    }

    function animateMotion(now) {
        if (previewPlaying && state?.entities?.[selected] && LOOP_TYPES.has(kind(state.entities[selected]))) {
            const e = state.entities[selected], per = Math.max(1, Number(e.period) || 120);
            if (!previewLast)
                previewLast = now;
            const dt = Math.min(.1, (now - previewLast) / 1000);
            previewLast = now;
            previewPct = (previewPct + dt * 100 * 60 / (2 * per)) % 100;
            if (now - previewTick >= 32) {
                previewTick = now;
                const scrub = $('motionScrub');
                if (scrub)
                    scrub.value = Math.round(previewPct);
                const label = $('motionScrubValue');
                if (label)
                    label.textContent = Math.round(previewPct) + '%';
                updateMotionReadout();
                render();
            }
        }
        else
            previewLast = now; requestAnimationFrame(animateMotion);
    }

    function stopMotion() {
        previewPlaying = false; previewLast = 0; const btn = $('motionPlay'); if (btn)
            btn.textContent = '▶ Play preview';
    }

    function chooseSelection(i) {
        if (selected !== i) {
            stopMotion();
            previewPct = 0;
            previewSelected = i;
        } selected = i;
    }

    function hitEntity(p) {
        for (let i = state.entities.length - 1; i >= 0; i--) {
            const e = state.entities[i], pad = Math.max(0.15, 6 / zoom);
            let ex = e.x0 / U, ey = e.y0 / U, ew = Math.max(.32, e.w / U), eh = Math.max(.32, e.h / U);
            if (p.x >= ex - pad && p.x <= ex + ew + pad && p.y >= ey - pad && p.y <= ey + eh + pad)
                return i;
        } return -1;
    }

    function cursor(p) { $('cursorInfo').textContent = `Tile: ${p.tx}, ${p.ty} · (${p.x.toFixed(2)}, ${p.y.toFixed(2)}) · ${currentTool.toUpperCase()}`; }

    function updateAll() { render(); updateStats(); refreshList(); refreshInspector(); }

    function updateStats() {
        const n = state.width * state.height, things = countThings(), countD = state.tiles.reduce((v, r) => v + (r.match(/D/g) || []).length, 0), json = JSON.stringify(state), bytes = new Blob([json]).size;
        let warnings = [];
        if (n > MAX_TILES)
            warnings.push('Map exceeds 40,000 tiles');
        if (things > MAX_OBJECTS)
            warnings.push('More than 400 things');
        if (bytes > MAX_BYTES)
            warnings.push('File exceeds about 2 MB');
        if (countD !== 2)
            warnings.push(countD ? 'Finish should have exactly two D tiles' : 'No finish door yet');
        if (state.entities.some(e => e.x0 < 0 || e.y0 < 0 || e.x0 + e.w > state.width * U || e.y0 + e.h > state.height * U))
            warnings.push('Some objects extend outside map');
        const nFmt = n.toLocaleString(), dText = countD === 2 ? '2 tiles' : countD + ' tiles';
        $('statSize').textContent = state.width + ' × ' + state.height;
        $('statTiles').textContent = nFmt + ' / 40,000';
        $('statObjects').textContent = things + ' / 400';
        /*$('objectCountLabel').textContent = things + ' / 400';*/
        $('statBytes').textContent = bytes < 1e6 ? (bytes / 1024).toFixed(1) + ' KB' : (bytes / 1e6).toFixed(2) + ' MB';
        $('statDoor').textContent = dText;
        $('statValid').textContent = warnings.length ? 'Check warnings' : 'Within limits';
        $('statValid').className = warnings.length ? 'status-warn' : 'status-ok';
        $('validationDetail').textContent = warnings.length ? warnings.join(' · ') : 'Tile area, object count and JSON size are within known limits.';
        $('entityTotal').textContent = state.entities.length;
    }

    function refreshList() {
        const list = $('entityList'); list.replaceChildren(); const q = $('entitySearch').value.trim().toLowerCase(); state.entities.forEach((e, i) => {
            const k = kind(e), name = TYPES[k] || k; if (q && !(`${name} ${i + 1}`).toLowerCase().includes(q))
                return; const b = document.createElement('button'); b.type = 'button'; b.className = 'item' + (i === selected ? ' sel' : ''); let number = document.createElement('span'); number.className = 'number'; number.textContent = '#' + (i + 1); let label = document.createElement('span'); label.className = 'itembody'; label.textContent = name + ' · ' + Number(e.x0 / U).toFixed(1) + ', ' + Number(e.y0 / U).toFixed(1); b.append(number, label); b.onclick = () => { chooseSelection(i); changeTool('select'); refreshList(); refreshInspector(); render(); }; list.append(b);
        });
    }

    function unitLabel(k) { return { x0: 'Start A — X (tiles)', y0: 'Start A — Y (tiles)', x1: 'End B — X (tiles)', y1: 'End B — Y (tiles)', w: 'Width (tiles)', h: 'Height (tiles)', trigX: 'Trigger X (tiles)', trigY: 'Trigger Y (tiles)', trigW: 'Trigger width (tiles)', trigH: 'Trigger height (tiles)', period: 'Movement period', phase: 'Phase / offset', trap: 'Trap ID', needs: 'Requires key ID' }[k] || k; }

    function fieldInput(e, key) {
        let v = e[key], line = document.createElement('div'); line.className = 'field'; let label = document.createElement('label'); label.textContent = unitLabel(key); const input = document.createElement('input'); input.type = typeof v === 'number' ? 'number' : 'text'; const units = ['x0', 'y0', 'x1', 'y1', 'w', 'h', 'trigX', 'trigY', 'trigW', 'trigH'].includes(key); input.value = units ? Number((v / U).toFixed(6)) : v; if (units) {
            input.step = '0.00390625';
            input.min = ['w', 'h', 'trigW', 'trigH'].includes(key) ? String(1 / U) : '';
        }
        else
            input.step = '1'; input.addEventListener('change', () => {
                if (selected < 0)
                    return; let value = Number(input.value); if (!Number.isFinite(value))
                    return; if (units)
                    value = Math.round(value * U);
                else
                    value = Math.round(value); if (['w', 'h', 'trigW', 'trigH', 'period'].includes(key) && value <= 0) {
                        alert('This value must be above zero.');
                        refreshInspector();
                        return;
                    } snapShot(); const ent = state.entities[selected]; if (key === 'x0' || key === 'y0') {
                        const delta = value - ent[key];
                        const other = key === 'x0' ? 'x1' : 'y1', trig = key === 'x0' ? 'trigX' : 'trigY';
                        ent[key] = value;
                        if (!LOOP_TYPES.has(kind(ent)))
                            ent[other] += delta;
                        if (typeof ent[trig] === 'number')
                            ent[trig] += delta;
                    }
                else
                    ent[key] = value; updateAll();
            }); line.append(label, input); return line;
    }

    function rawEntityEditor(e, box) {
        const details = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = 'Advanced: edit this object as raw JSON'; details.append(summary); const area = document.createElement('textarea'); area.id = 'rawEntity'; area.spellcheck = false; area.value = JSON.stringify(e, null, 2); details.append(area); const button = document.createElement('button'); button.className = 'small'; button.textContent = 'Apply raw JSON'; button.onclick = () => {
            try {
                const out = JSON.parse(area.value);
                if (!out || Array.isArray(out) || typeof out !== 'object')
                    throw Error('Must be one JSON object');
                for (const k of ['x0', 'y0', 'x1', 'y1', 'w', 'h'])
                    if (typeof out[k] !== 'number')
                        throw Error('Missing numeric ' + k);
                snapShot();
                state.entities[selected] = out;
                updateAll();
                setStatus('Object JSON updated');
            }
            catch (err) {
                alert('Invalid object JSON: ' + err.message);
            }
        }; details.append(button); box.append(details);
    }

    function appendMotionStudio(e, box) {
        const mover = LOOP_TYPES.has(kind(e));
        if (!mover)
            return;
        const panel = document.createElement('section');
        panel.className = 'motion-studio';
        panel.id = 'motionStudio';
        const title = document.createElement('h3');
        title.textContent = '↔ Motion studio';
        panel.append(title);
        const intro = document.createElement('p');
        intro.className = 'motion-meta';
        intro.textContent = kind(e) === 'SpikeBall' ? 'Matches the in-game Spike Ball Speed 1–8 and Phase 0–16 controls.' : 'Speed and phase presets are a convenience for this moving object. Test its actual timing in Jono.';
        panel.append(intro);
        let per = Math.max(1, Number(e.period) || 120);
        let currentSpeed = SPEED_PERIODS.indexOf(per) + 1;
        const spRow = document.createElement('div');
        spRow.className = 'motion-line';
        const spTitle = document.createElement('label');
        spTitle.textContent = 'Speed (1 slow → 8 fast)';
        spTitle.htmlFor = 'motionSpeed';
        const spLabel = document.createElement('span');
        spLabel.className = 'motion-value';
        spLabel.id = 'motionSpeedValue';
        spLabel.textContent = currentSpeed ? `${currentSpeed} / 8` : `Custom (${per})`;
        spRow.append(spTitle, spLabel);
        panel.append(spRow);
        const speed = document.createElement('input');
        speed.type = 'range';
        speed.id = 'motionSpeed';
        speed.min = 1;
        speed.max = 8;
        speed.step = 1;
        speed.value = currentSpeed || SPEED_PERIODS.reduce((best, val, i) => Math.abs(val - per) < Math.abs(SPEED_PERIODS[best] - per) ? i : best, 0) + 1;
        speed.setAttribute('aria-label', 'Speed preset from 1 to 8');
        panel.append(speed);
        const note = document.createElement('div');
        note.className = 'motion-meta';
        note.id = 'motionTiming';
        note.textContent = timingText(e);
        panel.append(note);
        const phaseRow = document.createElement('div');
        phaseRow.className = 'motion-line';
        const phTitle = document.createElement('label');
        phTitle.textContent = 'Phase (start position)';
        phTitle.htmlFor = 'motionPhase';
        const phLabel = document.createElement('span');
        phLabel.id = 'motionPhaseValue';
        phLabel.className = 'motion-value';
        phaseRow.append(phTitle, phLabel);
        panel.append(phaseRow);
        const phase = document.createElement('input');
        phase.type = 'range';
        phase.id = 'motionPhase';
        phase.min = 0;
        phase.max = 16;
        phase.step = 1;
        phase.setAttribute('aria-label', 'Start phase from 0 to 16');
        phase.value = Math.round(phaseFraction(e) * 16);
        phLabel.textContent = `${phase.value} / 16`;
        panel.append(phase);
        const help = document.createElement('div');
        help.className = 'motion-meta';
        help.textContent = '0 starts at A, 8 starts at B, 16 wraps to A. Intermediate positions also affect the direction of travel. The saved JSON stores the raw phase offset.';
        panel.append(help);
        const buttons = document.createElement('div');
        buttons.className = 'motion-row';
        for (const [caption, tool] of [['Set A on map', 'start'], ['Set B on map', 'end']]) {
            const b = document.createElement('button');
            b.textContent = caption;
            b.onclick = () => { stopMotion(); changeTool(tool); setStatus('Click map for ' + (tool === 'start' ? 'start A' : 'end B') + '. Hold Shift for 1/256-tile precision.'); };
            buttons.append(b);
        }
        panel.append(buttons);
        const swap = document.createElement('button');
        swap.className = 'small motion-toggle';
        swap.textContent = '⇄ Swap A and B';
        swap.onclick = () => { snapShot(); const target = state.entities[selected];[target.x0, target.x1] = [target.x1, target.x0];[target.y0, target.y1] = [target.y1, target.y0]; previewPct = 0; stopMotion(); updateAll(); setStatus('Swapped movement endpoints'); };
        panel.append(swap);
        const previewHead = document.createElement('div');
        previewHead.className = 'motion-line';
        const pLabel = document.createElement('label');
        pLabel.textContent = 'Cycle preview';
        pLabel.htmlFor = 'motionScrub';
        const pValue = document.createElement('span');
        pValue.className = 'motion-value';
        pValue.id = 'motionScrubValue';
        pValue.textContent = Math.round(previewPct) + '%';
        previewHead.append(pLabel, pValue);
        panel.append(previewHead);
        const scrub = document.createElement('input');
        scrub.type = 'range';
        scrub.id = 'motionScrub';
        scrub.min = 0;
        scrub.max = 100;
        scrub.step = 1;
        scrub.value = Math.round(previewPct);
        scrub.oninput = () => { stopMotion(); previewPct = Number(scrub.value); pValue.textContent = Math.round(previewPct) + '%'; updateMotionReadout(); render(); };
        panel.append(scrub);
        const motionNow = document.createElement('div');
        motionNow.className = 'motion-meta';
        motionNow.id = 'motionNow';
        panel.append(motionNow);
        const play = document.createElement('button');
        play.className = 'primary motion-toggle';
        play.id = 'motionPlay';
        play.textContent = previewPlaying ? 'Ⅱ Pause preview' : '▶ Play preview';
        play.onclick = () => { previewPlaying = !previewPlaying; previewLast = 0; play.textContent = previewPlaying ? 'Ⅱ Pause preview' : '▶ Play preview'; render(); };
        panel.append(play);
        const small = document.createElement('div');
        small.className = 'motion-hint';
        small.textContent = 'Visual preview approximates a back-and-forth motion at 60 FPS; Jono is the authority on actual motion. JSON positions remain unchanged.';
        panel.append(small);
        const raw = document.createElement('details');
        const sum = document.createElement('summary');
        sum.textContent = 'Advanced: exact period and phase values';
        raw.append(sum);
        const rawGrid = document.createElement('div');
        rawGrid.className = 'inspector-grid';
        for (const key of ['period', 'phase']) {
            if (!(key in e) && key === 'phase')
                continue;
            rawGrid.append(fieldInput(e, key));
        }
        raw.append(rawGrid);
        panel.append(raw);
        // Snapshot on the first interaction, then preview changes live. Release commits one undo step.
        function bindRange(el, fn) {
            let started = false; el.addEventListener('pointerdown', () => {
                if (!started) {
                    snapShot();
                    started = true;
                }
            }); el.addEventListener('input', () => {
                if (!started) {
                    snapShot();
                    started = true;
                } fn(Number(el.value)); render(); updateStats(); updateMotionReadout();
            }); el.addEventListener('change', () => { started = false; updateAll(); });
        }
        bindRange(speed, v => {
            const ent = state.entities[selected], oldPeriod = Math.max(1, Number(ent.period) || 120), frac = phaseFraction(ent); ent.period = SPEED_PERIODS[Math.max(0, Math.min(7, v - 1))]; if ('phase' in ent)
                ent.phase = Math.round(frac * 2 * ent.period); spLabel.textContent = v + ' / 8'; note.textContent = timingText(ent); phase.value = Math.round(phaseFraction(ent) * 16); phLabel.textContent = phase.value + ' / 16';
        });
        bindRange(phase, v => { const ent = state.entities[selected]; ent.phase = Math.round(2 * Math.max(1, Number(ent.period) || 120) * v / 16); phLabel.textContent = v + ' / 16'; });
        box.append(panel);
        updateMotionReadout();
    }

    function timingText(e) { const p = Math.max(1, Number(e.period) || 120); return `Saved period: ${p} frames · approximately ${(p / 60).toFixed(2)}s A→B, ${(2 * p / 60).toFixed(2)}s full cycle at 60 FPS.`; }

    function refreshInspector() {
        const box = $('entityInspector'), empty = $('emptyInspector');
        box.replaceChildren();
        const e = state.entities[selected];
        if (!e) {
            box.hidden = true;
            empty.hidden = false;
            $('selectionLabel').textContent = 'Nothing selected';
            return;
        }
        box.hidden = false;
        empty.hidden = true;
        $('selectionLabel').textContent = '#' + (selected + 1);
        let head = document.createElement('h3');
        head.style.margin = '0 0 7px';
        head.textContent = TYPES[kind(e)] || kind(e);
        box.append(head);
        let info = document.createElement('div');
        info.className = 'muted';
        info.textContent = 'Position and dimensions use tile units (256 internal units per tile).';
        box.append(info);
        const pairs = [['x0', 'y0'], ['w', 'h'], ['x1', 'y1']];
        for (const pair of pairs) {
            const grid = document.createElement('div');
            grid.className = 'inspector-grid';
            pair.forEach(key => grid.append(fieldInput(e, key)));
            box.append(grid);
        }
        appendMotionStudio(e, box);
        const actionRow = document.createElement('div');
        actionRow.className = 'row';
        for (const [label, cb, cl] of [['Set end on map', () => { changeTool('end'); setStatus('Click the map to set the selected object travel endpoint'); }, ''], ['Duplicate', () => {
            if (countThings() >= MAX_OBJECTS) {
                alert('400 thing limit');
                return;
            }
            snapShot();
            const cp = jsonDeepCopy(e); cp.x0 += U;
            cp.y0 += U; cp.x1 += U; cp.y1 += U;
            if ('trigX' in cp)
                cp.trigX += U;
            if ('trigY' in cp)
                cp.trigY += U; state.entities.push(cp); chooseSelection(state.entities.length - 1); updateAll();
        }, ''], ['Delete', () => { snapShot(); state.entities.splice(selected, 1); chooseSelection(-1); updateAll(); }, 'danger']]) {
            let b = document.createElement('button');
            b.className = 'small ' + cl;
            b.textContent = label;
            b.onclick = cb;
            actionRow.append(b);
        }
        box.append(actionRow);
        const otherKeys = Object.keys(e).filter(k => !['kind', 'x0', 'y0', 'w', 'h', 'x1', 'y1', ...(LOOP_TYPES.has(kind(e)) ? ['period', 'phase'] : [])].includes(k));
        for (const key of otherKeys)
            box.append(fieldInput(e, key));
        if (e.kind === 'Lock') {
            const p = document.createElement('p');
            p.className = 'notice';
            p.textContent = 'To link this lock to a key, set “Requires key ID” to the key’s Trap ID.';
            box.append(p);
        }
        rawEntityEditor(e, box);
    }

    function validateImport(data) {
        if (!data || typeof data !== 'object' || !Number.isInteger(data.width) || !Number.isInteger(data.height) || !Array.isArray(data.tiles) || !Array.isArray(data.entities))
            throw Error('Not a supported Jono level: expected width, height, tiles, entities'); const w = data.width, h = data.height; if (w < 4 || h < 4 || w * h > MAX_TILES)
            throw Error('Imported map must fit the 40,000 tile limit'); if (data.tiles.length !== h || data.tiles.some(r => typeof r !== 'string' || r.length !== w))
            throw Error('Tile data does not match its dimensions'); if (!Number.isInteger(data.spawnX) || !Number.isInteger(data.spawnY) || data.spawnX < 0 || data.spawnY < 0 || data.spawnX >= w || data.spawnY >= h)
            throw Error('Spawn coordinates are missing or outside the map'); if (!Number.isFinite(data.period))
            data.period = 120; return data;
    }

    function importFile(file) {
        if (!file)
            return; const reader = new FileReader(); reader.onload = () => {
                try {
                    let d = validateImport(JSON.parse(reader.result));
                    if (d.entities.length > MAX_OBJECTS)
                        alert('Imported file has more than 400 entities. You can inspect it, but Jono may reject the export.');
                    $('fileName').value = validateLevelName(file.name.replace(/\.json$/i, ''));
                    restore(d, true, true);
                    setStatus('Imported ' + file.name + ' successfully');
                }
                catch (err) {
                    alert('Cannot import this file: ' + err.message);
                    setStatus('Import failed');
                }
            }; reader.onerror = () => alert('Unable to read this file'); reader.readAsText(file);
    }

    function exportLevel() {
        const json = JSON.stringify(state), bytes = new Blob([json]).size, things = countThings(); if (things > MAX_OBJECTS || bytes > MAX_BYTES || state.width * state.height > MAX_TILES) {
            if (!confirm('This JSON exceeds at least one known Jono import limit and may fail to load. Download anyway?'))
                return;
        }
        const blob = new Blob([json], { type: 'application/json' }), url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = validateLevelName($('fileName').value) + '.json'; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 3000); dirty = false; setStatus('Downloaded ' + a.download + ' (' + (bytes / 1024).toFixed(1) + ' KB)');
    }

    canvas.addEventListener('contextmenu', ev => ev.preventDefault());
    canvas.addEventListener('wheel', ev => { ev.preventDefault(); const p = pointerPos(ev); zoomAt(Math.exp(-ev.deltaY * .0015), p.sx, p.sy); }, { passive: false });
    canvas.addEventListener('pointerdown', ev => {
        if (ev.button !== 0 && ev.button !== 1)
            return;
        canvas.setPointerCapture(ev.pointerId);
        const p = pointerPos(ev);
        hover = p;
        cursor(p);
        const active = (ev.button === 1 || spaceHeld) ? 'pan' : currentTool;
        if (active === 'pan') {
            drag = { type: 'pan', sx: p.sx, sy: p.sy, ox, oy };
            return;
        }
        if (!hasTile(p))
            return;

        /* BLOCKS and ENTRANCE/EXIT DOORS */

        if (active === 'door') {
            placeDoor(p.tx, p.ty);
            return;
        }
        else if (active === 'spawn') {
            snapShot();
            state.spawnX = p.tx;
            state.spawnY = p.ty;
            syncFields();
            updateAll();
            return;
        }
        else if (active === 'start' || active === 'end') {
            if (selected >= 0) {
                const e = state.entities[selected];
                const precise = $('fineCheck').checked || ev.shiftKey;
                const nx = Math.round((precise ? p.x : p.tx) * U), ny = Math.round((precise ? p.y : p.ty) * U);
                snapShot();
                if (active === 'end') {
                    e.x1 = nx;
                    e.y1 = ny;
                }
                else {
                    e.x0 = nx;
                    e.y0 = ny;
                }
                previewPct = 0;
                updateAll();
                changeTool('select');
                setStatus('Updated movement point ' + (active === 'end' ? 'B (end)' : 'A (start)') + (precise ? ' with precise placement' : ''));
            }
            return;
        }
        else if (active === 'select') {
            chooseSelection(hitEntity(p));
            if (selected >= 0) {
                snapShot();
                drag = { type: 'object', i: selected, p, original: jsonDeepCopy(state.entities[selected]) };
            }
            refreshList();
            refreshInspector();
            render();
            return;
        }
        else if (active === 'pick') {
            let c = tile(p.tx, p.ty);
            if (['#', '~', '^', '.'].includes(c))
                chooseMat(c);
            setStatus('Picked ' + (c || 'empty'));
            return;
        }
        else if (active === 'fill') {
            let c = material;
            if (tile(p.tx, p.ty) !== c) {
                snapShot();
                let count = fillRegion(p.tx, p.ty, c);
                updateAll();
                setStatus('Filled ' + count + ' tiles');
            }
            return;
        }
        else if (['brush', 'erase'].includes(active)) {
            snapShot();
            let c = active === 'erase' ? '.' : material;
            drag = { type: 'stroke', prev: p, material: c };
            brush(p.tx, p.ty, c, Math.floor(validNum('brushSize', 1)));
            render();
            return;
        }
        else if (active === 'line' || active === 'rect') {
            drag = { type: active, start: p, current: p };
            render();
            return;
        }

        /* ENTITIES */

        else {
            addEntityAt(active, p.x, p.y);
            return;
        }
    });
    canvas.addEventListener('pointermove', ev => {
        const p = pointerPos(ev);
        hover = p;
        cursor(p);
        if (!drag) {
            render();
            return;
        }
        if (drag.type === 'pan') {
            ox = drag.ox + p.sx - drag.sx;
            oy = drag.oy + p.sy - drag.sy;
        }
        else if (drag.type === 'stroke') {
            drawLine(drag.prev.tx, drag.prev.ty, p.tx, p.ty, drag.material, Math.floor(validNum('brushSize', 1)));
            drag.prev = p;
        }
        else if (drag.type === 'line' || drag.type === 'rect')
            drag.current = p;
        else if (drag.type === 'object') {
            const quantum = $('fineCheck').checked || ev.shiftKey ? 1 : 256;
            const xx = Math.round((p.x - drag.p.x) * U / quantum) * quantum, yy = Math.round((p.y - drag.p.y) * U / quantum) * quantum;
            const e = state.entities[drag.i];
            Object.assign(e, drag.original);
            updateObjPosition(drag.i, xx, yy);
        }
        render();
    });
    function release(ev) {
        if (!drag)
            return;
        const current = pointerPos(ev);
        if (drag.type === 'line' || drag.type === 'rect') {
            snapShot();
            const a = drag.start, b = hasTile(current) ? current : drag.current;
            if (drag.type === 'line')
                drawLine(a.tx, a.ty, b.tx, b.ty, material, Math.floor(validNum('brushSize', 1)));
            else
                drawRectTiles(a.tx, a.ty, b.tx, b.ty, material, $('rectMode').value === 'outline');
        }
        const t = drag.type;
        drag = null;
        if (['line', 'rect', 'stroke', 'object'].includes(t)) {
            updateAll();
        }
        else
            render();
    }
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', () => { drag = null; updateAll(); });
    canvas.addEventListener('pointerleave', () => { hover = null; render(); });
    let spaceHeld = false;
    document.addEventListener('keydown', e => {
        const tag = e.target?.tagName; if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag))
            return; if (e.code === 'Space') {
                spaceHeld = true;
                e.preventDefault();
                return;
            } if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
                e.preventDefault();
                e.shiftKey ? redoAction() : undoAction();
                return;
            } if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
                e.preventDefault();
                redoAction();
                return;
            } const m = { b: 'brush', e: 'erase', l: 'line', r: 'rect', f: 'fill', v: 'select', h: 'pan', d: 'door', s: 'spawn' }[e.key.toLowerCase()]; if (m) {
                changeTool(m);
                e.preventDefault();
            }
    });
    document.addEventListener('keyup', e => {
        if (e.code === 'Space')
            spaceHeld = false;
    });
    for (const button of document.querySelectorAll('[data-tool]'))
        button.addEventListener('click', () => changeTool(button.dataset.tool));
    for (const button of document.querySelectorAll('[data-mat]'))
        button.addEventListener('click', () => chooseMat(button.dataset.mat));
    for (const button of document.querySelectorAll('[data-ent]'))
        button.addEventListener('click', () => changeTool(button.dataset.ent, "entity"));
    $('entitySearch').oninput = refreshList;
    $('createBtn').onclick = () => {
        if (!validateLevelDimensions())
            return;
        if (dirty)
            $('newDialog').showModal();
        else
            createBlank();
    };
    $('newBtn').onclick = () => {
        if (dirty)
            $('newDialog').showModal();
        else
            createBlank();
    };
    function createBlank() {
        const dims = validateLevelDimensions(); if (!dims)
            return; const [w, h] = dims; const d = createLevel(w, h, $('fillStyle').value); restore(d, true, true); setStatus('Created ' + w + ' × ' + h + ' blank map');
    }
    $('confirmNew').onclick = () => { $('newDialog').close(); createBlank(); };
    $('cancelNew').onclick = () => $('newDialog').close();
    $('resizeBtn').onclick = resizeLevel;
    $('undoBtn').onclick = undoAction;
    $('redoBtn').onclick = redoAction;
    $('exportBtn').onclick = exportLevel;
    $('importBtn').onclick = () => $('importFile').click();
    $('importFile').onchange = e => { importFile(e.target.files[0]); e.target.value = ''; };
    $('zoomIn').onclick = () => zoomAt(1.3);
    $('zoomOut').onclick = () => zoomAt(1 / 1.3);
    $('fitBtn').onclick = fit;
    for (const id of ['gridCheck', 'objectCheck', 'pathCheck', 'motionCheck', 'signCheck', 'fineCheck'])
        $(id).addEventListener('change', render);
    for (const id of ['spawnX', 'spawnY', 'mapPeriod', 'mapTheme'])
        $(id).addEventListener('change', () => {
            const key = id === 'mapPeriod' ? 'period' : id === 'mapTheme' ? 'theme' : id; const raw = $(id).value; if (id === 'mapTheme' && raw === '') {
                if ('theme' in state) {
                    snapShot();
                    delete state.theme;
                    updateAll();
                }
                return;
            } let v = Number(raw); if (!Number.isFinite(v) || !Number.isInteger(v) || (['spawnX', 'spawnY'].includes(id) && (v < 0 || v >= state[id === 'spawnX' ? 'width' : 'height'])) || (id === 'mapPeriod' && v <= 0)) {
                alert('Invalid number or value outside the map.');
                syncFields();
                return;
            } snapShot(); state[key] = v; updateAll();
        });
    window.addEventListener('beforeunload', e => {
        if (dirty) {
            e.preventDefault();
            e.returnValue = '';
        }
    });
    state = createLevel(80, 48, 'border');
    syncFields();
    updateUndoButtons();
    sizeCanvas();
    fit();
    updateAll();
    requestAnimationFrame(animateMotion);
    const ro = new ResizeObserver(() => { sizeCanvas(); render(); });
    ro.observe(stage);
})();