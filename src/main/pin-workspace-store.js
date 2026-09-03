'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { requireImageDataURL, normalizePinBounds } = require('./ipc-validation');

const INDEX_VERSION = 1;
const MAX_PINS = 20;
const MAX_INDEX_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 128 * 1024 * 1024;
const MAX_WORKSPACE_IMAGE_BYTES = 256 * 1024 * 1024;
const IMAGE_NAME_RE = /^[a-f0-9]{64}\.(?:png|jpg|webp|gif|bmp)$/;
const IMAGE_EXTENSIONS = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
});

function imageDigest(mime, bytes) {
  return crypto.createHash('sha256').update(mime).update(bytes).digest('hex');
}

function normalizePinWorkspaceState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = {};
  const opacity = Number(value.opacity);
  if (Number.isFinite(opacity)) state.opacity = Math.max(0.3, Math.min(1, opacity));
  if (typeof value.locked === 'boolean') state.locked = value.locked;
  if (typeof value.onTop === 'boolean') state.onTop = value.onTop;
  if (typeof value.title === 'string' && value.title.length <= 512) state.title = value.title;
  if (typeof value.groupId === 'string' && /^group-[a-z0-9-]{1,120}$/i.test(value.groupId)) {
    state.groupId = value.groupId;
  }
  return Object.keys(state).length ? state : null;
}

function parseImageDataURL(dataURL) {
  const safe = requireImageDataURL(dataURL);
  const match = /^data:(image\/(?:png|jpe?g|webp|gif|bmp));base64,([\s\S]+)$/i.exec(safe);
  if (!match) throw new Error('贴图图片格式无效。');
  const mime = match[1].toLowerCase().replace('image/jpg', 'image/jpeg');
  const bytes = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('贴图图片大小无效。');
  return { mime, bytes, extension: IMAGE_EXTENSIONS[mime] };
}

function normalizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const payload = snapshot.payload && typeof snapshot.payload === 'object' ? snapshot.payload : snapshot;
  let bounds;
  try {
    bounds = normalizePinBounds(snapshot.bounds || payload.bounds);
  } catch (_) {
    return null;
  }
  const out = { bounds };
  if (payload.dataURL) {
    out.image = parseImageDataURL(payload.dataURL);
  } else if (typeof payload.text === 'string' && payload.text.length <= 1024 * 1024) {
    out.text = payload.text;
  } else if (typeof payload.color === 'string' && payload.color.length <= 128) {
    out.color = payload.color;
  } else if (typeof payload.file === 'string' && payload.file.length <= 8192 && path.isAbsolute(payload.file)) {
    out.file = path.resolve(payload.file);
  } else {
    return null;
  }
  const state = normalizePinWorkspaceState(snapshot.state || payload.state);
  if (state) out.state = state;
  return out;
}

function createPinWorkspaceStore({ rootDir, fsModule = fs, randomBytes = crypto.randomBytes } = {}) {
  if (!rootDir || !path.isAbsolute(rootDir)) throw new TypeError('贴图工作区目录必须是绝对路径。');
  const indexPath = path.join(rootDir, 'index.json');
  const imagesDir = path.join(rootDir, 'images');

  function ensureDirectories() {
    fsModule.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
    fsModule.mkdirSync(imagesDir, { recursive: true, mode: 0o700 });
    try { fsModule.chmodSync(rootDir, 0o700); } catch (_) {}
    try { fsModule.chmodSync(imagesDir, 0o700); } catch (_) {}
  }

  function privateAtomicWrite(target, data) {
    const parent = path.dirname(target);
    const temporary = path.join(parent, `.${path.basename(target)}-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
    let descriptor = null;
    try {
      descriptor = fsModule.openSync(temporary, 'wx', 0o600);
      fsModule.writeFileSync(descriptor, data);
      fsModule.fsyncSync(descriptor);
      fsModule.closeSync(descriptor);
      descriptor = null;
      fsModule.renameSync(temporary, target);
      try { fsModule.chmodSync(target, 0o600); } catch (_) {}
    } catch (error) {
      if (descriptor !== null) {
        try { fsModule.closeSync(descriptor); } catch (_) {}
      }
      try { fsModule.unlinkSync(temporary); } catch (_) {}
      throw error;
    }
  }

  function save(snapshots) {
    ensureDirectories();
    const normalized = (Array.isArray(snapshots) ? snapshots : [])
      .slice(0, MAX_PINS)
      .map(normalizeSnapshot)
      .filter(Boolean);
    let totalImageBytes = 0;
    const createdImages = [];
    const retainedImages = new Set();
    const entries = [];

    try {
      for (const pin of normalized) {
        const entry = { bounds: pin.bounds };
        if (pin.image) {
          totalImageBytes += pin.image.bytes.length;
          if (totalImageBytes > MAX_WORKSPACE_IMAGE_BYTES) throw new Error('贴图工作区图片总量超过 256 MiB。');
          const digest = imageDigest(pin.image.mime, pin.image.bytes);
          const imageFile = `${digest}.${pin.image.extension}`;
          const imagePath = path.join(imagesDir, imageFile);
          retainedImages.add(imageFile);
          let hadFile = false;
          let validExistingFile = false;
          try {
            const stat = fsModule.statSync(imagePath);
            hadFile = stat.isFile();
            if (hadFile && stat.size === pin.image.bytes.length) {
              const existingBytes = fsModule.readFileSync(imagePath);
              validExistingFile = existingBytes.length === pin.image.bytes.length
                && imageDigest(pin.image.mime, existingBytes) === digest;
            }
          } catch (_) {}
          if (!validExistingFile) {
            privateAtomicWrite(imagePath, pin.image.bytes);
            // 若是修复旧索引已引用的损坏文件，后续 index 写入失败时不能删掉它；
            // 只回滚本次真正新建的内容文件。
            if (!hadFile) createdImages.push(imageFile);
          }
          entry.kind = 'image';
          entry.imageFile = imageFile;
          entry.mime = pin.image.mime;
        } else if (Object.prototype.hasOwnProperty.call(pin, 'text')) {
          entry.kind = 'text';
          entry.text = pin.text;
        } else if (Object.prototype.hasOwnProperty.call(pin, 'color')) {
          entry.kind = 'color';
          entry.color = pin.color;
        } else {
          entry.kind = 'file';
          entry.file = pin.file;
        }
        if (pin.state) entry.state = pin.state;
        entries.push(entry);
      }

      privateAtomicWrite(indexPath, JSON.stringify({ version: INDEX_VERSION, pins: entries }));
    } catch (error) {
      for (const imageFile of createdImages) {
        try { fsModule.unlinkSync(path.join(imagesDir, imageFile)); } catch (_) {}
      }
      throw error;
    }

    // Only remove old content after the new index is durably in place.
    try {
      for (const name of fsModule.readdirSync(imagesDir)) {
        if (IMAGE_NAME_RE.test(name) && !retainedImages.has(name)) {
          try { fsModule.unlinkSync(path.join(imagesDir, name)); } catch (_) {}
        }
      }
    } catch (_) {}
    return entries.length;
  }

  function readIndex() {
    let stat;
    try {
      stat = fsModule.statSync(indexPath);
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_INDEX_BYTES) return null;
    const parsed = JSON.parse(fsModule.readFileSync(indexPath, 'utf8'));
    if (!parsed || parsed.version !== INDEX_VERSION || !Array.isArray(parsed.pins)) return null;
    return parsed.pins.slice(0, MAX_PINS);
  }

  function loadEntry(entry, budget) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    let bounds;
    try { bounds = normalizePinBounds(entry.bounds); } catch (_) { return null; }
    const out = { bounds };
    if (entry.kind === 'image') {
      if (typeof entry.imageFile !== 'string' || !IMAGE_NAME_RE.test(entry.imageFile)) return null;
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'].includes(entry.mime)) return null;
      const expectedExtension = IMAGE_EXTENSIONS[entry.mime];
      if (!entry.imageFile.endsWith(`.${expectedExtension}`)) return null;
      const imagePath = path.join(imagesDir, entry.imageFile);
      let stat;
      try { stat = fsModule.statSync(imagePath); } catch (_) { return null; }
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES || budget.bytes + stat.size > MAX_WORKSPACE_IMAGE_BYTES) return null;
      const bytes = fsModule.readFileSync(imagePath);
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || budget.bytes + bytes.length > MAX_WORKSPACE_IMAGE_BYTES) return null;
      budget.bytes += bytes.length;
      const digest = imageDigest(entry.mime, bytes);
      if (entry.imageFile !== `${digest}.${expectedExtension}`) return null;
      out.dataURL = `data:${entry.mime};base64,${bytes.toString('base64')}`;
      try { requireImageDataURL(out.dataURL); } catch (_) { return null; }
    } else if (entry.kind === 'text') {
      if (typeof entry.text !== 'string' || entry.text.length > 1024 * 1024) return null;
      out.text = entry.text;
    } else if (entry.kind === 'color') {
      if (typeof entry.color !== 'string' || entry.color.length > 128) return null;
      out.color = entry.color;
    } else if (entry.kind === 'file') {
      if (typeof entry.file !== 'string' || entry.file.length > 8192 || !path.isAbsolute(entry.file)) return null;
      try { if (!fsModule.statSync(entry.file).isFile()) return null; } catch (_) { return null; }
      out.file = path.resolve(entry.file);
    } else {
      return null;
    }
    const state = normalizePinWorkspaceState(entry.state);
    if (state) out.state = state;
    return out;
  }

  function load() {
    try {
      const entries = readIndex();
      if (!entries) return [];
      const budget = { bytes: 0 };
      return entries.map((entry) => loadEntry(entry, budget)).filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  return { save, load };
}

module.exports = { createPinWorkspaceStore, normalizePinWorkspaceState };
