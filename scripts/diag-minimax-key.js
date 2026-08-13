// 只读诊断：解密本地存的 MiniMax 密钥，同时探测国内站/海外站，定位 1004 根因。
// 绝不修改 config.json；输出对密钥脱敏（只给类型+前3字符+长度），不打印完整密钥。
// 用法：node_modules/.bin/electron scripts/diag-minimax-key.js
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

// 关键：app 名要与正式运行一致，safeStorage 才能命中同一条 Keychain 记录。
app.setName('困困截图工具');

const ENC_PREFIX = 'enc:v1:';

function decField(stored) {
  if (!stored || typeof stored !== 'string' || !stored.startsWith(ENC_PREFIX)) return stored || '';
  try {
    if (!safeStorage.isEncryptionAvailable()) return '__ENC_UNAVAILABLE__';
    return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'));
  } catch (e) {
    return '__DECRYPT_FAIL__:' + e.message;
  }
}

function keyKind(k) {
  if (!k) return '(空)';
  if (k.startsWith('eyJ')) return '按量付费 JWT（eyJ…，应可直连标准API）';
  if (k.startsWith('sk-cp-')) return '🟥 套餐/Coding Plan（sk-cp-…，不能直连标准API）';
  if (k.startsWith('sk-')) return 'sk- 开头（疑似其它平台/网关密钥）';
  return '未知前缀';
}

function fp(k) {
  if (!k) return '(空)';
  return `${k.slice(0, 3)}…(${k.length}字符)`;
}

async function probe(base, key) {
  const url = `${base.replace(/\/$/, '')}/chat/completions`;
  const body = { model: 'MiniMax-M3', messages: [{ role: 'user', content: '只回:好' }], stream: false, max_tokens: 4 };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let type = '', msg = '', codeNum = '';
    try {
      const j = JSON.parse(text);
      type = (j.error && j.error.type) || (j.base_resp && 'base_resp') || '';
      msg = (j.error && j.error.message) || (j.base_resp && j.base_resp.status_msg) || '';
      codeNum = String((j.base_resp && j.base_resp.status_code) || '');
      const m = /\((\d{3,4})\)/.exec(msg || '');
      if (!codeNum && m) codeNum = m[1];
    } catch (_) { msg = text.slice(0, 160); }
    return { url, http: res.status, ok: res.ok, type, codeNum, msg: (msg || '').slice(0, 160) };
  } catch (e) {
    return { url, http: 'NETERR', ok: false, type: '', codeNum: '', msg: e.message };
  }
}

app.whenReady().then(async () => {
  const out = [];
  const log = (s) => out.push(s);
  try {
    const cfgPath = path.join(app.getPath('userData'), 'config.json');
    log('配置文件: ' + cfgPath);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const enc = (cfg.minimax && cfg.minimax.apiKey) || '';
    const key = decField(enc);
    log('safeStorage 可用: ' + (() => { try { return safeStorage.isEncryptionAvailable(); } catch (_) { return false; } })());

    if (key === '__ENC_UNAVAILABLE__' || String(key).startsWith('__DECRYPT_FAIL__')) {
      log('❌ 解密失败：' + key + '（可能 Keychain 访问被拒，或加密身份不一致）。改用手动 curl 方案。');
    } else {
      log('密钥类型: ' + keyKind(key) + '  指纹: ' + fp(key));
      log('配置 baseUrl: ' + (cfg.minimax && cfg.minimax.baseUrl));
      log('—— 同一把 key 分别探测两站 ——');
      const cn = await probe('https://api.minimaxi.com/v1', key);
      const io = await probe('https://api.minimax.io/v1', key);
      const show = (tag, r) => log(`【${tag}】HTTP ${r.http}${r.ok ? ' ✅可用' : ''}  code=${r.codeNum || '-'}  type=${r.type || '-'}\n         ${r.msg}`);
      show('国内站 minimaxi.com', cn);
      show('海外站 minimax.io', io);

      // 用 app 的真实代码路径再打一次（stream:true + thinking 关闭），复现「测试连接」那条请求
      log('—— 用 app 真实代码路径(deepseek.completeText)复测国内站 ——');
      try {
        const ds = require(path.join(process.cwd(), 'src/main/deepseek.js'));
        const txt = await ds.completeText({
          baseUrl: (cfg.minimax && cfg.minimax.baseUrl) || 'https://api.minimaxi.com/v1',
          apiKey: key,
          model: (cfg.minimax && cfg.minimax.textModel) || 'MiniMax-M3',
          messages: [{ role: 'user', content: '只回复两个字：你好' }],
        });
        log('【app 路径】✅ 成功，返回: ' + JSON.stringify((txt || '').slice(0, 40)));
      } catch (e) {
        log('【app 路径】❌ 失败: ' + e.message);
      }

      log('—— 判读 ——');
      if (cn.ok || io.ok) log('✅ 这把 key 在' + (cn.ok ? '国内站' : '海外站') + '有效。把 baseUrl 指向有效的那一站即可。');
      else if (String(keyKind(key)).includes('sk-cp-')) log('🟥 根因：套餐/Coding Plan 密钥，不能直连标准 API。请改用「按量付费」接口密钥。');
      else log('🟥 两站都拒：key 已失效/复制残缺，或非本账户密钥。请到 platform.minimaxi.com 账户管理→接口密钥 重新生成。');
    }
  } catch (e) {
    log('❌ 诊断异常: ' + e.message);
  }
  // 统一输出，便于复制
  process.stdout.write('\n===DIAG-START===\n' + out.join('\n') + '\n===DIAG-END===\n');
  app.quit();
});
