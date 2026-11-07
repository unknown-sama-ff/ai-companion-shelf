/* A dependency-free runtime. Serialize createCodexCompanionsRuntime for injection. */
(function exposeCompanions(root) {
  function createCodexCompanionsRuntime(environment) {
    const win = environment || globalThis;

    function createTimeline(options = {}) {
      const stages = options.stages;
      const selectedLoopExitIndex = stages.loop.frames.indexOf(stages.loop.exitFrame);
      const followsSelectedLoopExit = Boolean(stages.loop.completeOnLeave && selectedLoopExitIndex >= 0);
      const now = options.now || (() => win.performance.now());
      const requestFrame = options.requestFrame || ((callback) => win.requestAnimationFrame(callback));
      const cancelFrame = options.cancelFrame || ((handle) => win.cancelAnimationFrame(handle));
      const transitionDuration = options.transitionDuration ?? 220;
      let phase = 'idle';
      let elapsed = 0;
      let lastTime = now();
      let transition = null;
      let exitSleepStrength = 1;
      let handle = null;
      let hoverIntent = false;
      let paused = false;
      let destroyed = false;
      let reducedMotion = Boolean(options.reducedMotion);

      function duration(name) {
        const stage = stages[name];
        const intervals = name === 'loop' ? stage.frames.length : Math.max(1, stage.frames.length - 1);
        return intervals / stage.fps * 1000;
      }

      function sleepWeight(pose) {
        if (!options.sleepSway) return 0;
        if (pose.phase === 'loop') return 1;
        if (pose.phase === 'settle') return .15;
        if (pose.phase !== 'exit') return 0;
        const index = stages.exit.frames.indexOf(pose.frame);
        return exitSleepStrength * Math.max(0, 1 - index / Math.max(1, (stages.exit.frames.length - 1) * .55));
      }

      function snapshot() {
        const stage = stages[phase];
        const progress = phase === 'idle' ? 0 : elapsed / duration(phase);
        const position = phase === 'loop' ? progress * stage.frames.length : progress * (stage.frames.length - 1);
        const index = Math.min(stage.frames.length - 1, Math.floor(position));
        const nextIndex = phase === 'loop' ? (index + 1) % stage.frames.length : Math.min(index + 1, stage.frames.length - 1);
        const from = transition ? transition.from : { phase, frame: stage.frames[index] };
        const to = transition ? { phase, frame: stage.frames[0] } : { phase, frame: stage.frames[nextIndex] };
        const blend = transition ? transition.elapsed / transitionDuration : position - index;
        return {
          phase, progress, time: lastTime, loopProgress: phase === 'loop' ? progress : 0,
          frame: stage.frames[index], hoverIntent, paused, destroyed, running: handle !== null,
          from, to, blend,
          sleepStrength: sleepWeight(from) * (1 - blend) + sleepWeight(to) * blend,
        };
      }

      function dominantPose() {
        const sample = snapshot();
        return sample.blend < 0.5 ? sample.from : sample.to;
      }

      function begin(nextPhase, from) {
        if (nextPhase === 'exit') exitSleepStrength = sleepWeight(from);
        phase = nextPhase;
        elapsed = 0;
        const next = stages[phase];
        const samePose = from.frame === next.frames[0] && stages[from.phase].src === next.src;
        transition = transitionDuration > 0 && !samePose ? { from, elapsed: 0 } : null;
      }

      function advance(time) {
        let remaining = Math.max(0, time - lastTime);
        lastTime = time;
        if (paused || reducedMotion) return;
        while (remaining > 0) {
          if (transition) {
            const consumed = Math.min(remaining, transitionDuration - transition.elapsed);
            transition.elapsed += consumed;
            remaining -= consumed;
            if (transition.elapsed < transitionDuration) break;
            transition = null;
          } else if (phase === 'idle') {
            break;
          } else if (phase === 'loop') {
            if (hoverIntent) {
              elapsed = (elapsed + remaining) % duration(phase);
              break;
            }
            const frameDuration = 1000 / stages.loop.fps;
            const selectedExitTime = selectedLoopExitIndex * frameDuration;
            const finishWrap = followsSelectedLoopExit && elapsed > selectedExitTime + 1e-7;
            const boundary = followsSelectedLoopExit ? (finishWrap ? duration('loop') : selectedExitTime) :
              stages.loop.completeOnLeave ? duration('loop') :
                (Math.floor(elapsed / frameDuration + 1e-7) + 1) * frameDuration;
            const consumed = Math.min(remaining, boundary - elapsed);
            elapsed += consumed;
            remaining -= consumed;
            if (elapsed < boundary - 1e-7) break;
            // Finish a tween already in progress, then reach the matching closing pose next cycle.
            if (finishWrap) {
              elapsed = 0;
              continue;
            }
            const frame = followsSelectedLoopExit ? stages.loop.frames[selectedLoopExitIndex] :
              stages.loop.frames[Math.round(boundary / frameDuration) % stages.loop.frames.length];
            begin('exit', { phase: 'loop', frame });
          } else {
            const consumed = Math.min(remaining, duration(phase) - elapsed);
            elapsed += consumed;
            remaining -= consumed;
            if (elapsed < duration(phase)) break;
            const from = { phase, frame: stages[phase].frames.at(-1) };
            let nextPhase = hoverIntent ? 'enter' : 'idle';
            if (phase === 'enter') nextPhase = hoverIntent || followsSelectedLoopExit ? (stages.settle ? 'settle' : 'loop') : 'exit';
            if (phase === 'settle') nextPhase = hoverIntent || followsSelectedLoopExit ? 'loop' : 'exit';
            begin(nextPhase, from);
          }
        }
      }

      function render() { options.onUpdate?.(snapshot()); }

      function schedule() {
        if (handle === null && !destroyed && !paused && !reducedMotion && (phase !== 'idle' || transition)) handle = requestFrame(tick);
      }

      function stopFrame() {
        if (handle !== null) cancelFrame(handle);
        handle = null;
      }

      function tick(time) {
        handle = null;
        if (destroyed || paused) return;
        advance(time);
        render();
        schedule();
      }

      function setIntent(value) {
        if (destroyed) return;
        advance(now());
        hoverIntent = Boolean(value);
        if (reducedMotion) {
          phase = hoverIntent ? 'loop' : 'idle';
          elapsed = 0;
          transition = null;
        } else if (phase === 'idle' && hoverIntent) begin('enter', dominantPose());
        render();
        schedule();
      }

      return {
        setIntent,
        setTarget: (value) => setIntent(value > 0),
        setPaused(value) {
          if (destroyed || paused === value) return;
          advance(now());
          paused = value;
          stopFrame();
          schedule();
        },
        setReducedMotion(value) {
          if (destroyed) return;
          advance(now());
          reducedMotion = value;
          stopFrame();
          setIntent(hoverIntent);
        },
        inspect: snapshot,
        destroy() {
          stopFrame();
          destroyed = true;
        },
      };
    }

    function createMotionRenderer(canvas) {
      const gl = canvas.getContext?.('webgl', { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
      if (!gl) return null;
      const vertexSource = `
        attribute vec2 position;
        varying vec2 coordinate;
        void main() {
          coordinate = position;
          gl_Position = vec4(position.x * 2.0 - 1.0, 1.0 - position.y * 2.0, 0.0, 1.0);
        }`;
      const fragmentSource = `
        precision highp float;
        varying vec2 coordinate;
        uniform sampler2D atlasFrom;
        uniform sampler2D atlasTo;
        uniform sampler2D motionField;
        uniform vec4 frameFrom;
        uniform vec4 frameTo;
        uniform vec4 offsetFrom;
        uniform vec4 offsetTo;
        uniform vec4 scaleFrom;
        uniform vec4 scaleTo;
        uniform vec2 faceFrom;
        uniform vec2 faceTo;
        uniform float blend;
        uniform float motionScale;
        uniform vec2 sleepSway;

        vec4 samplePose(sampler2D atlas, vec4 frame, vec4 offset, vec4 sizing, vec2 faceOffset, vec2 point) {
          vec2 anchor = vec2(sizing.z, 1.0 - sizing.w / offset.w);
          if (faceOffset.x != 0.0 || faceOffset.y != 0.0) {
            float upper = clamp((point.y - 0.04) / 0.52, 0.0, 1.0);
            float lower = clamp((anchor.y - point.y) / (anchor.y - 0.56), 0.0, 1.0);
            point += faceOffset * min(upper, lower);
          }
          point = anchor + (point - anchor) / sizing.xy;
          vec2 local = vec2(point.x - offset.x,
            (point.y * offset.w - offset.w + offset.z + offset.y) / offset.z);
          if (local.x < 0.0 || local.x > 1.0 || local.y < 0.0 || local.y > 1.0) return vec4(0.0);
          return texture2D(atlas, frame.xy + local * frame.zw);
        }

        void main() {
          vec2 point = coordinate;
          if (sleepSway.x != 0.0 || sleepSway.y != 0.0) {
            float headWeight = 1.0 - smoothstep(0.54, 0.70, point.y);
            float angle = sleepSway.x * headWeight;
            float cosine = cos(angle);
            float sine = sin(angle);
            vec2 neck = vec2(0.5, 0.58);
            point = mat2(cosine, -sine, sine, cosine) *
              (point - neck - vec2(0.0, sleepSway.y * headWeight)) + neck;
          }
          if (blend <= 0.0001) {
            gl_FragColor = samplePose(atlasFrom, frameFrom, offsetFrom, scaleFrom, faceFrom, point);
            return;
          }
          vec4 displacement = (texture2D(motionField, clamp(point, 0.0, 1.0)) * 255.0 - 128.0) * motionScale;
          vec2 sourcePoint = point - blend * displacement.rg;
          vec2 targetPoint = point - (1.0 - blend) * displacement.ba;
          gl_FragColor = mix(samplePose(atlasFrom, frameFrom, offsetFrom, scaleFrom, faceFrom, sourcePoint),
            samplePose(atlasTo, frameTo, offsetTo, scaleTo, faceTo, targetPoint), blend);
        }`;
      const shaders = [];
      const program = gl.createProgram();
      for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]]) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        shaders.push(shader);
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        for (const shader of shaders) gl.deleteShader(shader);
        gl.deleteProgram(program);
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        return null;
      }
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
      gl.useProgram(program);
      const position = gl.getAttribLocation(program, 'position');
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      const uniforms = Object.fromEntries(['atlasFrom', 'atlasTo', 'motionField', 'frameFrom', 'frameTo',
        'offsetFrom', 'offsetTo', 'scaleFrom', 'scaleTo', 'faceFrom', 'faceTo', 'blend', 'motionScale', 'sleepSway'].map((name) => [name, gl.getUniformLocation(program, name)]));
      gl.uniform1i(uniforms.atlasFrom, 0);
      gl.uniform1i(uniforms.atlasTo, 1);
      gl.uniform1i(uniforms.motionField, 2);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.clearColor(0, 0, 0, 0);
      const images = new Map();
      const fields = new Map();
      const textures = [];

      function makeTexture(source, size) {
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        // Vector channels are independent numbers, while sprite colors use premultiplied alpha.
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !size);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        if (size) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
        else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        textures.push(texture);
        return texture;
      }

      const stillField = makeTexture(new Uint8Array([128, 128, 128, 128]), 1);

      function bindPose(unit, pose, ratio, stages, anchor) {
        const stage = stages[pose.phase];
        const image = images.get(stage.src);
        const frameUniform = unit === 0 ? uniforms.frameFrom : uniforms.frameTo;
        const offsetUniform = unit === 0 ? uniforms.offsetFrom : uniforms.offsetTo;
        const scaleUniform = unit === 0 ? uniforms.scaleFrom : uniforms.scaleTo;
        const faceUniform = unit === 0 ? uniforms.faceFrom : uniforms.faceTo;
        const offset = stage.offsets?.[pose.frame] || [0, 0];
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, image.texture);
        gl.uniform4f(frameUniform, pose.frame % stage.columns / stage.columns + .5 / image.width,
          Math.floor(pose.frame / stage.columns) / stage.rows + .5 / image.height,
          1 / stage.columns - 1 / image.width, 1 / stage.rows - 1 / image.height);
        gl.uniform4f(offsetUniform, offset[0], offset[1], stage.ratio, ratio);
        const scale = stage.scale || 1;
        gl.uniform4f(scaleUniform, scale, stage.scalesY?.[pose.frame] ?? scale, anchor[0], anchor[1]);
        gl.uniform2f(faceUniform, stage.faceOffset?.[0] || 0, stage.faceOffset?.[1] || 0);
      }

      return {
        addImage(source, picture, columns, rows) {
          if (images.has(source)) return;
          const factor = Math.min(1, 128 * columns / picture.naturalWidth, 128 * rows / picture.naturalHeight);
          const bitmap = win.document.createElement('canvas');
          bitmap.width = Math.round(picture.naturalWidth * factor);
          bitmap.height = Math.round(picture.naturalHeight * factor);
          bitmap.getContext('2d').drawImage(picture, 0, 0, bitmap.width, bitmap.height);
          images.set(source, { texture: makeTexture(bitmap), width: bitmap.width, height: bitmap.height });
        },
        prepareMotion(id, motion) {
          for (const [key, encoded] of Object.entries(motion.pairs)) {
            const bytes = Uint8Array.from(win.atob(encoded), (value) => value.charCodeAt(0));
            fields.set(`${id}|${key}`, makeTexture(bytes, motion.grid));
          }
        },
        begin(width, height) {
          if (gl.isContextLost()) return false;
          const resolution = Math.min(2, win.devicePixelRatio || 1);
          const pixelWidth = Math.max(1, Math.round(width * resolution));
          const pixelHeight = Math.max(1, Math.round(height * resolution));
          if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
            canvas.width = pixelWidth;
            canvas.height = pixelHeight;
          }
          gl.clear(gl.COLOR_BUFFER_BIT);
          return true;
        },
        draw(state) {
          const { sample, stages, character, spriteWidth: width, ratio } = state;
          const motion = character.motion;
          if (!motion?.pairs || !images.has(stages[sample.from.phase].src) || !images.has(stages[sample.to.phase].src)) return false;
          const resolution = Math.min(2, win.devicePixelRatio || 1);
          gl.viewport(Math.round(state.sceneX * resolution), 0, Math.round(width * resolution), Math.round(width * ratio * resolution));
          const key = `${character.id}|${sample.from.phase}:${sample.from.frame}>${sample.to.phase}:${sample.to.frame}`;
          bindPose(0, sample.from, ratio, stages, character.anchor || [.5, 0]);
          bindPose(1, sample.to, ratio, stages, character.anchor || [.5, 0]);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, fields.get(key) || stillField);
          gl.uniform1f(uniforms.blend, sample.blend);
          gl.uniform1f(uniforms.motionScale, motion.scale);
          let strength = motion.sleepSway ? sample.sleepStrength : 0;
          strength = strength * strength * (3 - 2 * strength);
          const rhythm = Math.sin(sample.time / 2800 * Math.PI * 2);
          gl.uniform2f(uniforms.sleepSway, strength * (12 + rhythm * 1.5) * Math.PI / 180, strength * rhythm * .012);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
          return true;
        },
        destroy() {
          for (const texture of textures) gl.deleteTexture(texture);
          for (const shader of shaders) gl.deleteShader(shader);
          gl.deleteProgram(program);
          gl.deleteBuffer(buffer);
          gl.getExtension('WEBGL_lose_context')?.loseContext();
        },
      };
    }

    function install(config = {}) {
      const doc = win.document;
      if (!doc?.documentElement) throw new Error('A browser document is required.');
      win.__codexCompanionsInstance?.destroy();
      const characters = config.characters || [];
      const host = doc.createElement('div');
      host.id = 'codex-companions-host';
      host.setAttribute('data-codex-companions', '');
      host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483000;';
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `<style>
        :host{all:initial;color-scheme:light dark;pointer-events:none}
        *{box-sizing:border-box}[hidden]{display:none!important}
        .shelf{position:fixed;display:flex;align-items:flex-end;justify-content:flex-start;gap:0;pointer-events:none;visibility:hidden;isolation:isolate;z-index:1}
        .scene{position:fixed;display:block;pointer-events:none;visibility:hidden;z-index:0}
        .character{position:relative;display:block;flex:none;margin:0;padding:0;border:0;background:transparent;pointer-events:auto;touch-action:manipulation;cursor:pointer;outline:none;overflow:visible;isolation:isolate;-webkit-tap-highlight-color:transparent}
        .character:focus-visible{border-radius:18px;outline:2px solid #9c80de;outline-offset:2px}
        .sprite{position:absolute;left:50%;bottom:0;transform:translateX(-50%);display:block;background-repeat:no-repeat;pointer-events:none;image-rendering:auto;mix-blend-mode:plus-lighter}
        .label{position:absolute;bottom:100%;left:50%;transform:translate(-50%,-5px);font:11px/1.4 system-ui,sans-serif;white-space:nowrap;padding:3px 7px;color:#56446e;background:#fffaf2f2;border:1px solid #decff1;border-radius:7px;opacity:0;pointer-events:none;box-shadow:0 3px 12px #36254c12}
        .character:focus-visible .label{opacity:1}
        .dream{position:absolute;width:140%;height:55%;left:-20%;top:-25%;pointer-events:none;opacity:0;transform:translateY(8px);filter:drop-shadow(0 2px 3px #44266b20)}
        .dream svg{display:block;width:100%;height:100%;overflow:visible}
        @media(prefers-contrast:more){.character:focus-visible{outline:3px solid currentColor}}
      </style><div class="shelf" role="group" aria-label="AI companions"></div>`;
      const shelf = shadow.querySelector('.shelf');
      const media = win.matchMedia?.('(prefers-reduced-motion: reduce)');
      const listeners = [];
      const timers = new Set();
      const states = [];
      let composer = null;
      let reservation = null;
      let destroyed = false;
      let layoutFrame = null;
      let reconnectTimer = null;
      let queuedSearch = false;
      const canvas = doc.createElement('canvas');
      canvas.className = 'scene';
      canvas.setAttribute('aria-hidden', 'true');
      canvas.hidden = true;
      const renderer = characters.some((character) => character.motion?.pairs) ? createMotionRenderer(canvas) : null;
      if (renderer) shadow.append(canvas);
      const frameCallbacks = new Map();
      let nextFrameId = 0;
      let sceneFrame = null;
      let insideSceneFrame = false;
      let sceneDirty = false;
      let sceneWidth = 0;
      let sceneHeight = 0;

      function scheduleSceneFrame() {
        if (destroyed || sceneFrame !== null || insideSceneFrame) return;
        sceneFrame = win.requestAnimationFrame((time) => {
          sceneFrame = null;
          insideSceneFrame = true;
          const callbacks = [...frameCallbacks.values()];
          frameCallbacks.clear();
          for (const callback of callbacks) callback(time);
          if (sceneDirty) {
            sceneDirty = false;
            const ready = sceneWidth > 0 && renderer.begin(sceneWidth, sceneHeight);
            canvas.hidden = !ready;
            for (const state of states) {
              state.motionRendered = Boolean(ready && state.loaded && renderer.draw(state));
              state.paint(state.sample, state.motionRendered);
            }
          }
          insideSceneFrame = false;
          if (frameCallbacks.size || sceneDirty) scheduleSceneFrame();
        });
      }

      function requestSharedFrame(callback) {
        const id = ++nextFrameId;
        frameCallbacks.set(id, callback);
        scheduleSceneFrame();
        return id;
      }

      function cancelSharedFrame(id) {
        frameCallbacks.delete(id);
        if (!frameCallbacks.size && !sceneDirty && sceneFrame !== null) {
          win.cancelAnimationFrame(sceneFrame);
          sceneFrame = null;
        }
      }

      function setShelfVisibility(value) {
        shelf.style.visibility = value;
        if (renderer) canvas.style.visibility = value;
      }

      function listen(target, type, callback, options) {
        target.addEventListener(type, callback, options);
        listeners.push(() => target.removeEventListener(type, callback, options));
      }

      function addDream(button) {
        const dream = doc.createElement('span');
        dream.className = 'dream';
        dream.setAttribute('aria-hidden', 'true');
        dream.innerHTML = `<svg viewBox="0 0 160 76" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="35" cy="65" r="3" fill="#d6c2f0"/><circle cx="45" cy="55" r="5" fill="#e2d5f3"/>
          <path d="M30 44C13 45 12 26 24 23C19 9 40 2 49 13C59 0 80 3 83 17C98 7 116 15 116 27C136 22 146 45 128 52H40Z" fill="#fcf8ff" stroke="#bd9fdf" stroke-width="1.8"/>
          <rect x="35" y="27" width="24" height="17" rx="2" fill="#d8c9ed" stroke="#8670a6"/><path d="M31 46H64L60 43H35Z" fill="#8670a6"/>
          <path d="M42 34L39 36L42 38M51 34L54 36L51 38M48 32L45 40" stroke="#74539f" stroke-width="1.4" stroke-linecap="round"/>
          <path d="M103 33C95 33 94 23 101 22C100 13 112 11 116 18C124 14 133 19 131 26C139 29 134 35 129 35H103" fill="#e4d7f3" stroke="#9980b7" stroke-width="1.3"/>
          <rect x="109" y="29" width="17" height="13" rx="2" fill="#fff" stroke="#9980b7"/><path d="M112 33H123M112 37H123" stroke="#ad93c8"/><circle cx="122" cy="33" r=".8" fill="#73a59a"/>
          <path d="M65 35H93" stroke="#d0bce6" stroke-dasharray="2 3"/>
          <g class="packet"><rect x="-6" y="-4" width="12" height="8" rx="2" fill="#b28cd9"/><path d="M-2-2L-4 0L-2 2M2-2L4 0L2 2" stroke="white" stroke-width="1"/></g>
        </svg>`;
        button.append(dream);
        return { element: dream, packet: dream.querySelector('.packet') };
      }

      for (const character of characters) {
        if (renderer && character.motion?.pairs) renderer.prepareMotion(character.id, character.motion);
        const legacyCount = Math.max(1, character.frames || 8);
        const legacy = { src: character.src, columns: character.columns || 4, rows: character.rows || 2 };
        const configured = character.animations || {
          idle: { ...legacy, frames: [0] },
          enter: { ...legacy, frames: Array.from({ length: legacyCount }, (_, index) => index), fps: (legacyCount - 1) / ((character.duration || 1600) / 1000) },
          loop: { ...legacy, frames: [legacyCount - 1] },
          exit: { ...legacy, frames: [0] },
        };
        const stages = {};
        for (const phase of ['idle', 'enter', 'settle', 'loop', 'exit']) {
          if (phase === 'settle' && !configured.settle) continue;
          const stage = configured[phase];
          if (!stage?.src || !Array.isArray(stage.frames) || !stage.frames.length) throw new Error(`Invalid ${phase} animation for ${character.id}`);
          const columns = Math.max(1, stage.columns || 1);
          const rows = Math.max(1, stage.rows || 1);
          if (stage.frames.some((index) => !Number.isInteger(index) || index < 0 || index >= columns * rows)) throw new Error(`Invalid ${phase} frame for ${character.id}`);
          stages[phase] = { ...stage, src: config.images?.[stage.src] || stage.src, columns, rows, fps: Math.max(1, stage.fps || 18), ratio: character.cellRatio || 1 };
        }
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'character';
        button.dataset.character = character.id;
        button.setAttribute('aria-label', `${character.name || character.id}${character.action ? ` · ${character.action}` : ''}`);
        const layers = [doc.createElement('span'), doc.createElement('span')];
        for (const layer of layers) {
          layer.className = 'sprite';
          layer.setAttribute('aria-hidden', 'true');
          button.append(layer);
        }
        const anchor = character.anchor || [.5, 0];
        const label = doc.createElement('span');
        label.className = 'label';
        label.textContent = character.name || character.id;
        button.append(label);
        const dream = character.effect === 'upload' ? addDream(button) : null;
        const state = { character, button, layers, dream, stages, ratio: character.cellRatio || 1, spriteWidth: config.characterWidth || 56,
          sceneX: 0, motionRendered: false, hovered: false, focused: false, frame: 0, loaded: false, failed: false, pictures: [] };
        function paint(layer, pose, opacity) {
          const stage = stages[pose.phase];
          if (layer.paintedStage !== stage) {
            layer.style.backgroundImage = `url(${JSON.stringify(stage.src)})`;
            layer.style.backgroundSize = `${stage.columns * 100}% ${stage.rows * 100}%`;
            layer.paintedStage = stage;
          }
          const column = pose.frame % stage.columns;
          const row = Math.floor(pose.frame / stage.columns);
          const offset = stage.offsets?.[pose.frame] || [0, 0];
          const scale = stage.scale || 1;
          const verticalScale = stage.scalesY?.[pose.frame] ?? scale;
          layer.style.backgroundPosition = `${stage.columns > 1 ? column / (stage.columns - 1) * 100 : 0}% ${stage.rows > 1 ? row / (stage.rows - 1) * 100 : 0}%`;
          layer.style.width = `${state.spriteWidth * scale}px`;
          layer.style.height = `${state.spriteWidth * stage.ratio * verticalScale}px`;
          layer.style.left = `calc(50% + ${(offset[0] * scale + (1 - scale) * (anchor[0] - .5)) * state.spriteWidth}px)`;
          layer.style.bottom = `${(offset[1] * verticalScale + (1 - verticalScale) * anchor[1]) * state.spriteWidth}px`;
          layer.style.opacity = String(opacity);
        }
        state.paint = (sample, rendered) => {
          if (!rendered) {
            paint(layers[0], sample.from, 1 - sample.blend);
            paint(layers[1], sample.to, sample.blend);
          }
          for (const layer of layers) if (Boolean(layer.hidden) !== rendered) layer.hidden = rendered;
          if (dream) {
            let visibility = 0;
            if (sample.phase === 'enter') visibility = Math.max(0, Math.min(1, (sample.progress - 0.3) / 0.6));
            if (sample.phase === 'settle' || sample.phase === 'loop') visibility = 1;
            if (sample.phase === 'exit') visibility = 1 - sample.progress;
            if (sample.phase === 'loop') {
              dream.packetProgress = (sample.loopProgress * 2) % 1;
              dream.packetOpacity = Math.sin(dream.packetProgress * Math.PI);
            }
            dream.element.style.opacity = String(visibility);
            dream.element.style.transform = `translateY(${(1 - visibility) * 8}px)`;
            dream.packet.setAttribute('transform', `translate(${67 + (dream.packetProgress || 0) * 25} 35)`);
            dream.packet.style.opacity = String((dream.packetOpacity || 0) * visibility);
          }
        };
        state.render = (sample) => {
          state.frame = sample.frame;
          state.sample = sample;
          if (renderer) {
            sceneDirty = true;
            scheduleSceneFrame();
          } else state.paint(sample, false);
        };
        state.timeline = createTimeline({ stages, reducedMotion: media?.matches, onUpdate: state.render,
          sleepSway: Boolean(character.motion?.sleepSway),
          requestFrame: renderer ? requestSharedFrame : undefined, cancelFrame: renderer ? cancelSharedFrame : undefined });
        state.render(state.timeline.inspect());
        const updateTarget = () => state.timeline.setIntent(state.hovered || state.focused);
        listen(button, 'pointerenter', (event) => { if (event.pointerType !== 'touch') { state.hovered = true; updateTarget(); } });
        listen(button, 'pointerleave', () => { state.hovered = false; updateTarget(); });
        listen(button, 'pointercancel', () => { state.hovered = false; updateTarget(); });
        listen(button, 'pointerdown', (event) => { if (event.pointerType === 'mouse') event.preventDefault(); });
        listen(button, 'focus', () => { state.focused = button.matches(':focus-visible'); updateTarget(); });
        listen(button, 'blur', () => { state.focused = false; updateTarget(); });
        const sources = [...new Set(Object.values(stages).map((stage) => stage.src))];
        let loadedImages = 0;
        for (const source of sources) {
          const picture = new win.Image();
          picture.onload = () => {
            if (destroyed) return;
            for (const stage of Object.values(stages)) {
              if (stage.src === source) stage.ratio = (picture.naturalHeight / stage.rows) / (picture.naturalWidth / stage.columns);
            }
            state.ratio = Math.max(...Object.values(stages).map((stage) => stage.ratio));
            const stage = Object.values(stages).find((stage) => stage.src === source);
            renderer?.addImage(source, picture, stage.columns, stage.rows);
            state.loaded = ++loadedImages === sources.length;
            state.render(state.timeline.inspect());
            scheduleLayout();
          };
          picture.onerror = () => { if (!destroyed) { state.failed = true; button.hidden = true; scheduleLayout(); } };
          state.pictures.push(picture);
          picture.src = source;
        }
        if (doc.hidden) state.timeline.setPaused(true);
        shelf.append(button);
        states.push(state);
      }

      function isVisible(element) {
        if (!element?.isConnected) return false;
        if (element.checkVisibility && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
        const rect = element.getBoundingClientRect();
        const style = win.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' &&
          style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.opacity !== '0';
      }

      function findComposer() {
        if (config.getComposer) return config.getComposer();
        const selector = config.composerSelector || '#prompt-textarea, [contenteditable="true"][role="textbox"], textarea';
        const input = [...doc.querySelectorAll(selector)].find(isVisible);
        if (config.composerSelector) return input || null;
        return input?.closest('form') || input?.parentElement || null;
      }

      function popupCoversShelf(bounds) {
        const modals = doc.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]');
        if ([...modals].some(isVisible)) return true;
        const popups = doc.querySelectorAll('[role="menu"], [role="listbox"]');
        return [...popups].some((popup) => {
          if (!isVisible(popup)) return false;
          const rect = popup.getBoundingClientRect();
          return rect.left < bounds.right && rect.right > bounds.left && rect.top < bounds.bottom && rect.bottom > bounds.top;
        });
      }

      function restoreComposerSpace() {
        if (!reservation) return;
        const { element, originalValue, originalPriority, appliedValue, appliedPriority } = reservation;
        if (element.style.getPropertyValue('padding-top') === appliedValue &&
            element.style.getPropertyPriority('padding-top') === appliedPriority) {
          if (originalValue) element.style.setProperty('padding-top', originalValue, originalPriority);
          else element.style.removeProperty('padding-top');
        }
        reservation = null;
      }

      function reserveComposerSpace(height) {
        const root = config.reserveComposerSpace ? composer?.closest('[data-codex-composer-root]') : null;
        if (reservation?.element !== root) restoreComposerSpace();
        if (!root) return false;
        if (reservation && (root.style.getPropertyValue('padding-top') !== reservation.appliedValue ||
            root.style.getPropertyPriority('padding-top') !== reservation.appliedPriority)) reservation = null;
        if (!reservation) {
          reservation = {
            element: root,
            originalValue: root.style.getPropertyValue('padding-top'),
            originalPriority: root.style.getPropertyPriority('padding-top'),
            basePadding: Number.parseFloat(win.getComputedStyle(root).paddingTop) || 0,
            appliedValue: null,
            appliedPriority: 'important',
          };
        }
        const value = `${reservation.basePadding + height + 6}px`;
        if (root.style.getPropertyValue('padding-top') === value &&
            root.style.getPropertyPriority('padding-top') === reservation.appliedPriority) return false;
        root.style.setProperty('padding-top', value, reservation.appliedPriority);
        reservation.appliedValue = root.style.getPropertyValue('padding-top');
        return true;
      }

      function layout() {
        layoutFrame = null;
        if (destroyed) return;
        if (!composer?.isConnected) { restoreComposerSpace(); setShelfVisibility('hidden'); return; }
        const rect = composer.getBoundingClientRect();
        const viewportTop = win.visualViewport?.offsetTop || 0;
        const viewportHeight = win.visualViewport?.height || win.innerHeight;
        if (!isVisible(composer) || rect.width < 50 || rect.height < 10 || rect.bottom < viewportTop || rect.top > viewportTop + viewportHeight) {
          restoreComposerSpace();
          setShelfVisibility('hidden');
          return;
        }
        const overlap = Math.max(0, Math.min(config.overlap ?? 3, 8));
        const reserveRoot = config.reserveComposerSpace ? composer.closest('[data-codex-composer-root]') : null;
        const reserveStyle = reserveRoot ? win.getComputedStyle(reserveRoot) : null;
        const seatTop = reserveRoot
          ? reserveRoot.getBoundingClientRect().top + (Number.parseFloat(reserveStyle.paddingTop) || 0) + (Number.parseFloat(reserveStyle.borderTopWidth) || 0)
          : rect.top;
        const bottom = seatTop + (reserveRoot ? 0 : overlap);
        const availableHeight = Math.max(0, bottom - viewportTop - 8);
        const largestVisualRatio = Math.max(1, ...states.map((state) => state.ratio * (state.dream ? 1.25 : 1)));
        const requestedWidth = config.characterWidth || 56;
        const requestedAdvance = Math.max(8, requestedWidth + (config.gap ?? -8));
        const rightInset = Math.max(0, config.rightInset ?? 8);
        const requestedRowWidth = requestedWidth + (Math.max(1, states.length) - 1) * requestedAdvance;
        const scale = Math.max(0, Math.min(1, (rect.width - rightInset * 2) / requestedRowWidth, availableHeight / (requestedWidth * largestVisualRatio)));
        const width = requestedWidth * scale;
        const advance = requestedAdvance * scale;
        if (width < 8) { restoreComposerSpace(); setShelfVisibility('hidden'); return; }
        let height = 0;
        let sceneX = 0;
        for (const state of states) {
          const characterHeight = width * state.ratio;
          height = Math.max(height, characterHeight);
          state.spriteWidth = width;
          state.sceneX = sceneX;
          sceneX += advance;
          state.button.style.width = `${advance}px`;
          state.button.style.height = `${characterHeight}px`;
          state.render(state.timeline.inspect());
        }
        if (reserveComposerSpace(width * largestVisualRatio)) scheduleLayout();
        const bleed = (width - advance) / 2;
        const shelfWidth = advance * states.length;
        const shelfRight = rect.right - rightInset - bleed;
        const shelfLeft = shelfRight - shelfWidth;
        shelf.style.left = `${shelfLeft}px`;
        shelf.style.width = `${shelfWidth}px`;
        shelf.style.height = `${height}px`;
        shelf.style.top = `${bottom - height}px`;
        if (renderer) {
          sceneWidth = shelfWidth + bleed * 2;
          sceneHeight = height;
          canvas.style.left = `${shelfLeft - bleed}px`;
          canvas.style.top = `${bottom - height}px`;
          canvas.style.width = `${sceneWidth}px`;
          canvas.style.height = `${height}px`;
        }
        const bounds = { left: shelfLeft - Math.max(0, bleed), right: shelfRight + Math.max(0, bleed), top: bottom - height, bottom };
        setShelfVisibility(popupCoversShelf(bounds) ? 'hidden' : 'visible');
      }

      function scheduleLayout() {
        if (!destroyed && layoutFrame === null) layoutFrame = win.requestAnimationFrame(layout);
      }

      const resizeObserver = win.ResizeObserver ? new win.ResizeObserver(scheduleLayout) : null;

      function reconnect() {
        if (destroyed) return;
        queuedSearch = false;
        const next = findComposer();
        if (next !== composer) {
          resizeObserver?.disconnect();
          composer = next;
          if (composer) resizeObserver?.observe(composer);
        }
        scheduleLayout();
      }

      function queueReconnect() {
        if (destroyed || queuedSearch) return;
        queuedSearch = true;
        reconnectTimer = win.setTimeout(() => {
          timers.delete(reconnectTimer);
          reconnectTimer = null;
          reconnect();
        }, 120);
        timers.add(reconnectTimer);
      }

      const observer = new win.MutationObserver((records) => {
        if (records.some((record) => record.type === 'childList' || record.type === 'attributes')) queueReconnect();
      });
      observer.observe(doc.body || doc.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-hidden', 'aria-expanded', 'aria-modal', 'data-state'],
      });
      listen(win, 'resize', scheduleLayout, { passive: true });
      listen(doc, 'scroll', scheduleLayout, { capture: true, passive: true });
      if (win.visualViewport) {
        listen(win.visualViewport, 'resize', scheduleLayout, { passive: true });
        listen(win.visualViewport, 'scroll', scheduleLayout, { passive: true });
      }
      listen(doc, 'visibilitychange', () => {
        for (const state of states) state.timeline.setPaused(doc.hidden);
        if (!doc.hidden) scheduleLayout();
      });
      const motionChange = () => { for (const state of states) state.timeline.setReducedMotion(media.matches); };
      if (media?.addEventListener) listen(media, 'change', motionChange);
      else if (media?.addListener) {
        media.addListener(motionChange);
        listeners.push(() => media.removeListener(motionChange));
      }
      (doc.body || doc.documentElement).append(host);
      reconnect();

      const instance = {
        host,
        inspect() {
          return {
            connected: Boolean(composer?.isConnected),
            destroyed,
            sharedRenderer: Boolean(renderer),
            characters: states.map((state) => ({ id: state.character.id, frame: state.frame, loaded: state.loaded, failed: state.failed,
              spriteWidth: state.spriteWidth, interpolation: state.motionRendered ? 'motion' : 'crossfade',
              procedural: Boolean(state.character.motion?.sleepSway), ...state.timeline.inspect() })),
          };
        },
        setActive(id, active) {
          const state = states.find((item) => item.character.id === id);
          if (state) state.timeline.setIntent(active);
        },
        refresh: reconnect,
        destroy() {
          if (destroyed) return;
          destroyed = true;
          restoreComposerSpace();
          observer.disconnect();
          resizeObserver?.disconnect();
          if (layoutFrame !== null) win.cancelAnimationFrame(layoutFrame);
          for (const timer of timers) win.clearTimeout(timer);
          timers.clear();
          for (const remove of listeners) remove();
          for (const state of states) {
            state.timeline.destroy();
            for (const picture of state.pictures) {
              picture.onload = null;
              picture.onerror = null;
            }
          }
          if (sceneFrame !== null) win.cancelAnimationFrame(sceneFrame);
          frameCallbacks.clear();
          renderer?.destroy();
          host.remove();
          if (win.__codexCompanionsInstance === instance) delete win.__codexCompanionsInstance;
        },
      };
      win.__codexCompanionsInstance = instance;
      return instance;
    }

    return { install, createTimeline };
  }

  root.createCodexCompanionsRuntime = createCodexCompanionsRuntime;
  root.CodexCompanions = createCodexCompanionsRuntime(root);
  root.installCodexCompanions = root.CodexCompanions.install;
})(globalThis);
