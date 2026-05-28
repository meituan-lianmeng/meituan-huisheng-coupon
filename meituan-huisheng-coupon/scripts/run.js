#!/usr/bin/env node
/**
 * huisheng-coupon-tool 统一入口脚本
 *
 * 跨平台（macOS / Windows）统一调度，AI 只需执行:
 *   node run.js <command> [options]
 *
 * 子命令:
 *   init                          环境初始化（Python检查 + npm检查 + pt-passport安装）
 *   get-device-token              获取设备标识
 *   get-token [--env test|prod]   获取缓存的用户Token
 *   auth-get-code [--env test|prod]  获取授权链接
 *   auth-poll-token               轮询授权结果
 *   qrcode <url> [client_id]      生成二维码PNG
 *   issue --token <t>             领券
 *   hotword --city-id <id>        热搜词查询
 *   search --keyword <kw> --lat <lat> --lng <lng> --token <t> --city-id <id> [--page N] [--page-size N] [--query-id Q] [--request-id R] [--max-distance-km D]
 *   location --token <t>          获取用户近期位置
 *   location-by-address --address <addr>  根据地址获取经纬度
 *   order --product-id <pid> --poi-id <pid> --token <t> --city-id <id> --uuid <u> [--lat <lat>] [--lng <lng>] [--quantity N]
 *   logout                        退出登录
 *   clear-device-token            清除设备标识
 *
 * 所有命令输出 JSON 到 stdout，错误信息输出到 stderr。
 */

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ── 全局常量 ─────────────────────────────────────────────────
const SCRIPTS_DIR = __dirname;
const SKILL_DIR = path.dirname(SCRIPTS_DIR);
const CLIENT_ID = 'c6f50b5a1e2f4e2bb00a3e2f58df3ced';
const PYTHON = findPython();

// 动态获取 certifi 证书路径，用于修复 macOS Python SSL 证书问题
// 若 certifi 未安装则为空字符串，Python 脚本使用系统默认证书
const CERT_FILE = (() => {
  try {
    return execSync(`${PYTHON} -m certifi`, { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim();
  } catch (_) { return ''; }
})();

// ── 工具函数 ─────────────────────────────────────────────────

function findPython() {
  for (const cmd of ['python3', 'python']) {
    try {
      const ver = execSync(`${cmd} --version`, { encoding: 'utf-8', timeout: 10000, stdio: 'pipe' }).trim();
      if (ver && !ver.startsWith('Python 2.')) return cmd;
    } catch (_) { /* ignore */ }
  }
  return 'python3';
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function fail(error, extra) {
  out(Object.assign({ ok: false, error }, extra || {}));
  process.exit(1);
}

/** 执行 Python 脚本，返回解析后的 JSON */
function runPython(scriptName, args) {
  const scriptPath = path.join(SCRIPTS_DIR, scriptName);
  const cmdArgs = [scriptPath, ...args];
  try {
    const sslEnv = CERT_FILE
      ? { SSL_CERT_FILE: CERT_FILE, REQUESTS_CA_BUNDLE: CERT_FILE }
      : {};
    const result = spawnSync(PYTHON, cmdArgs, {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: SCRIPTS_DIR,
      env: Object.assign({}, process.env, sslEnv)
    });
    const stdout = (result.stdout || '').trim();
    if (result.status !== 0) {
      try { return JSON.parse(stdout); } catch (_) {}
      return { ok: false, error: 'SCRIPT_ERROR', message: (result.stderr || stdout || 'Unknown error').trim() };
    }
    try { return JSON.parse(stdout); } catch (_) {
      return { ok: false, error: 'PARSE_ERROR', message: 'Invalid JSON from script', raw: stdout };
    }
  } catch (e) {
    return { ok: false, error: 'EXEC_ERROR', message: e.message };
  }
}

/** 执行 pt-passport CLI 命令，返回原始 stdout */
function runPassport(args) {
  try {
    const result = spawnSync('pt-passport', args, {
      encoding: 'utf-8',
      timeout: 120000,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true
    });
    return {
      exitCode: result.status,
      stdout: (result.stdout || '').trim(),
      stderr: (result.stderr || '').trim()
    };
  } catch (e) {
    return { exitCode: 1, stdout: '', stderr: e.message };
  }
}

/** 解析 --key value 形式的命令行参数 */
function parseArgs(argv) {
  const args = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[key] = argv[++i];
      } else {
        args[key] = 'true';
      }
    } else {
      positional.push(argv[i]);
    }
  }
  return { args, positional };
}

// ── 子命令实现 ───────────────────────────────────────────────

const commands = {};

/**
 * init — 环境初始化
 */
commands.init = function () {
  // 1. 路径验证
  if (!fs.existsSync(SCRIPTS_DIR) || !fs.statSync(SCRIPTS_DIR).isDirectory()) {
    fail('PATH_NOT_FOUND');
  }

  // 2. Python 检查
  let pyVer = '';
  try {
    pyVer = execSync(`${PYTHON} --version`, { encoding: 'utf-8', timeout: 10000, stdio: 'pipe' }).trim();
  } catch (_) { /* ignore */ }

  if (!pyVer) fail('PYTHON_NOT_FOUND');
  if (pyVer.startsWith('Python 2.')) fail('PYTHON_VERSION_2');

  // 3. Node.js 版本检查
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor < 18) {
    fail('NODE_VERSION_LOW', { current: String(nodeMajor), required: '>=18' });
  }

  // 4. npm 检查
  try {
    execSync('npm --version', { encoding: 'utf-8', timeout: 10000, stdio: 'pipe' });
  } catch (_) {
    fail('NPM_NOT_FOUND');
  }

  // 5. pt-passport CLI 安装/更新
  // ClawHub 会删除非文本文件（.tgz/.bin 等），因此将 tgz base64 编码为 .txt 存储
  // 查找优先级：.tgz（本地开发） > .txt（ClawHub 发布）
  let tgzFile = null;
  let bundleVersion = '';

  const allFiles = fs.readdirSync(SCRIPTS_DIR);
  const directTgz = allFiles
    .filter(f => f.startsWith('mtuser-pt-passport-') && f.endsWith('.tgz'))
    .sort()
    .map(f => path.join(SCRIPTS_DIR, f));

  if (directTgz.length > 0) {
    // 本地开发环境：直接使用 .tgz 文件
    tgzFile = directTgz[directTgz.length - 1];
    bundleVersion = path.basename(tgzFile).replace('mtuser-pt-passport-', '').replace('.tgz', '');
  } else {
    // ClawHub 发布环境：从 .txt（base64 编码）还原 .tgz
    const txtFiles = allFiles
      .filter(f => f.startsWith('mtuser-pt-passport-') && f.endsWith('.txt'))
      .sort()
      .map(f => path.join(SCRIPTS_DIR, f));

    if (txtFiles.length === 0) fail('TGZ_NOT_FOUND');

    const txtFile = txtFiles[txtFiles.length - 1];
    bundleVersion = path.basename(txtFile).replace('mtuser-pt-passport-', '').replace('.txt', '');

    // 将 base64 编码的 .txt 还原为临时 .tgz 文件
    const b64Content = fs.readFileSync(txtFile, 'utf-8').replace(/\s/g, '');
    const tgzBuffer = Buffer.from(b64Content, 'base64');
    tgzFile = path.join(SCRIPTS_DIR, `mtuser-pt-passport-${bundleVersion}.tgz`);
    fs.writeFileSync(tgzFile, tgzBuffer);
  }

  let localVersion = '';
  try {
    const res = spawnSync('pt-passport', ['--version'], { encoding: 'utf-8', timeout: 10000, stdio: 'pipe', shell: true });
    localVersion = (res.stdout || '').trim().split('\n').pop();
  } catch (_) { /* not installed */ }

  if (localVersion !== bundleVersion) {
    try {
      execSync(`npm install -g "${tgzFile}" --save-exact --force`, { encoding: 'utf-8', timeout: 60000, stdio: 'pipe' });
    } catch (_) {
      fail('INSTALL_FAILED');
    }
  }

  out({ ok: true, scripts_dir: SCRIPTS_DIR, skill_dir: SKILL_DIR });
};

/**
 * get-device-token — 获取设备标识
 */
commands['get-device-token'] = function () {
  const result = runPython('auth.py', ['get-device-token']);
  if (result.success && result.device_token) {
    out({ ok: true, device_token: result.device_token });
  } else if (result.device_token) {
    out({ ok: true, device_token: result.device_token });
  } else {
    fail('DEVICE_TOKEN_FAILED', { detail: result });
  }
};

/**
 * get-token — 获取缓存的用户 Token
 */
commands['get-token'] = function (argv) {
  const { args } = parseArgs(argv || []);
  const passportArgs = ['get-token', '--client_id', CLIENT_ID];
  if (args['env'] === 'test') {
    passportArgs.push('--env', 'test');
  }
  const res = runPassport(passportArgs);
  if (res.exitCode === 0 && res.stdout) {
    out({ ok: true, token: res.stdout });
  } else {
    out({ ok: false, error: 'NO_TOKEN', message: 'Token not found or expired' });
  }
};

/**
 * auth-get-code — 获取授权链接
 */
commands['auth-get-code'] = function (argv) {
  const { args } = parseArgs(argv || []);
  const passportArgs = ['auth', 'get-code', '--client_id', CLIENT_ID];
  if (args['env'] === 'test') {
    passportArgs.push('--env', 'test');
  }
  const res = runPassport(passportArgs);
  const stdout = res.stdout;

  // Token: <token> — 缓存命中
  const tokenMatch = stdout.match(/Token:\s*(.+)/);
  if (tokenMatch) {
    out({ ok: true, type: 'token', token: tokenMatch[1].trim() });
    return;
  }

  // AUTH_LINK: <url>
  const linkMatch = stdout.match(/AUTH_LINK:\s*(.+)/);
  if (linkMatch) {
    out({ ok: true, type: 'auth_link', url: linkMatch[1].trim() });
    return;
  }

  // ❌ 错误
  const errorMatch = stdout.match(/❌\s*code=(\d+)\s*message=(.*)/);
  if (errorMatch) {
    out({ ok: false, error: 'AUTH_ERROR', code: errorMatch[1], message: errorMatch[2].trim() });
    return;
  }

  out({ ok: false, error: 'UNKNOWN', raw: stdout, stderr: res.stderr });
};

/**
 * auth-poll-token — 轮询授权结果
 * 注意：poll-token 从 get-code 生成的 session 文件读取环境信息，无需传 --env
 */
commands['auth-poll-token'] = function () {
  const res = runPassport(['auth', 'poll-token', '--client_id', CLIENT_ID]);
  const stdout = res.stdout;

  const tokenMatch = stdout.match(/Token:\s*(.+)/);
  if (res.exitCode === 0 && tokenMatch) {
    out({ ok: true, token: tokenMatch[1].trim() });
    return;
  }

  const errorMatch = stdout.match(/❌\s*code=(\d+)\s*message=(.*)/);
  if (errorMatch) {
    out({ ok: false, error: 'POLL_ERROR', code: errorMatch[1], message: errorMatch[2].trim() });
    return;
  }

  out({ ok: false, error: 'POLL_FAILED', raw: stdout, stderr: res.stderr });
};

/**
 * qrcode — 生成二维码 PNG
 * 用法: node run.js qrcode <url> [client_id]
 */
commands.qrcode = function (argv) {
  const url = (argv || [])[0] || '';
  const clientId = (argv || [])[1] || '';

  if (!url) {
    out({ ok: false, type: 'skip' });
    return;
  }

  let imgFile;
  let isRandFile = false;

  if (clientId) {
    imgFile = path.join(SCRIPTS_DIR, `qrcode_${clientId}.png`);
  } else {
    const rand = crypto.randomBytes(4).toString('hex');
    imgFile = path.join(SCRIPTS_DIR, `qrcode_${rand}.png`);
    isRandFile = true;
  }

  // 退出时清理随机文件
  function cleanup() {
    if (isRandFile) {
      try { fs.unlinkSync(imgFile); } catch (_) { /* ignore */ }
    }
  }
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(1); });
  process.on('SIGTERM', () => { cleanup(); process.exit(1); });

  // 获取 npm 全局模块路径
  let nodeGlobalModules = '';
  try {
    nodeGlobalModules = execSync('npm root -g', { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (_) { /* ignore */ }

  // 注入全局模块搜索路径
  if (nodeGlobalModules && fs.existsSync(nodeGlobalModules)) {
    if (!module.paths.includes(nodeGlobalModules)) {
      module.paths.push(nodeGlobalModules);
    }
  }

  // 加载 qrcode 模块
  let qr;
  try {
    qr = require('qrcode');
  } catch (_) {
    process.stderr.write('[run.js:qrcode] qrcode module not found, installing...\n');
    try {
      execSync('npm install -g qrcode', { encoding: 'utf-8', timeout: 60000, stdio: 'pipe' });
    } catch (__) {
      out({ ok: false, type: 'skip' });
      return;
    }
    try {
      nodeGlobalModules = execSync('npm root -g', { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      if (nodeGlobalModules && !module.paths.includes(nodeGlobalModules)) {
        module.paths.push(nodeGlobalModules);
      }
    } catch (__) { /* keep old */ }
    try {
      qr = require('qrcode');
    } catch (__) {
      out({ ok: false, type: 'skip' });
      return;
    }
  }

  // 生成 PNG（异步回调）
  qr.toFile(imgFile, url, {
    type: 'png',
    width: 300,
    margin: 2,
    errorCorrectionLevel: 'M'
  }, (err) => {
    if (!err) {
      out({ ok: true, type: 'image', path: imgFile });
    } else {
      out({ ok: false, type: 'skip' });
    }
  });
};

/**
 * issue — 领券
 * 用法: node run.js issue --token <t>
 */
commands.issue = function (argv) {
  const { args } = parseArgs(argv || []);
  if (!args['token']) fail('MISSING_PARAM', { param: 'token' });
  const result = runPython('issue.py', ['--token', args['token']]);
  out(Object.assign({ ok: !!result.success }, result));
};

/**
 * hotword — 热搜词查询
 * 用法: node run.js hotword --city-id <id>
 */
commands.hotword = function (argv) {
  const { args } = parseArgs(argv || []);
  if (!args['city-id']) fail('MISSING_PARAM', { param: 'city-id' });
  const result = runPython('hotword.py', ['--city-id', args['city-id']]);
  out(Object.assign({ ok: !!result.success }, result));
};

/**
 * search — 商品搜索
 * 用法: node run.js search --keyword <kw> --lat <lat> --lng <lng> --token <t> --city-id <id>
 *        [--page N] [--page-size N] [--query-id Q] [--request-id R] [--max-distance-km D]
 */
commands.search = function (argv) {
  const { args } = parseArgs(argv || []);
  const required = ['keyword', 'lat', 'lng', 'token', 'city-id'];
  for (const r of required) {
    if (!args[r]) fail('MISSING_PARAM', { param: r });
  }

  const pyArgs = [
    '--keyword', args['keyword'],
    '--lat', args['lat'],
    '--lng', args['lng'],
    '--token', args['token'],
    '--city-id', args['city-id']
  ];

  if (args['page'])           { pyArgs.push('--page', args['page']); }
  if (args['page-size'])      { pyArgs.push('--page-size', args['page-size']); }
  if (args['query-id'])       { pyArgs.push('--query-id', args['query-id']); }
  if (args['request-id'])     { pyArgs.push('--request-id', args['request-id']); }
  if (args['max-distance-km']) { pyArgs.push('--max-distance-km', args['max-distance-km']); }

  const result = runPython('product_search.py', pyArgs);
  out(Object.assign({ ok: !!result.success }, result));
};

/**
 * location — 获取用户近期位置
 * 用法: node run.js location --token <t>
 */
commands.location = function (argv) {
  const { args } = parseArgs(argv || []);
  if (!args['token']) fail('MISSING_PARAM', { param: 'token' });
  const result = runPython('get_user_recent_location.py', ['--token', args['token']]);
  out(Object.assign({ ok: !!result.success }, result));
};

/**
 * location-by-address — 根据地址获取经纬度
 * 用法: node run.js location-by-address --address <addr>
 */
commands['location-by-address'] = function (argv) {
  const { args } = parseArgs(argv || []);
  if (!args['address']) fail('MISSING_PARAM', { param: 'address' });
  const result = runPython('get_location_by_address.py', ['--address', args['address']]);
  out(Object.assign({ ok: !!result.success }, result));
};

/**
 * order — 下单
 * 用法: node run.js order --product-id <pid> --poi-id <pid> --token <t> --city-id <id> --uuid <u>
 *        [--lat <lat>] [--lng <lng>] [--quantity N]
 */
commands.order = function (argv) {
  const { args } = parseArgs(argv || []);
  const required = ['product-id', 'poi-id', 'token', 'city-id', 'uuid'];
  for (const r of required) {
    if (!args[r]) fail('MISSING_PARAM', { param: r });
  }

  const pyArgs = [
    '--product-id', args['product-id'],
    '--poi-id', args['poi-id'],
    '--token', args['token'],
    '--city-id', args['city-id'],
    '--uuid', args['uuid']
  ];

  if (args['lat'])      { pyArgs.push('--lat', args['lat']); }
  if (args['lng'])      { pyArgs.push('--lng', args['lng']); }
  if (args['quantity']) { pyArgs.push('--quantity', args['quantity']); }

  const result = runPython('order.py', pyArgs);
  out(Object.assign({ ok: !!result.success }, result));
};

/**
 * logout — 退出登录
 */
commands.logout = function () {
  const result = runPython('auth.py', ['logout']);
  out(Object.assign({ ok: !!result.success }, result));
};

/**
 * clear-device-token — 清除设备标识
 */
commands['clear-device-token'] = function () {
  const result = runPython('auth.py', ['clear-device-token']);
  out(Object.assign({ ok: !!result.success }, result));
};

// ── 入口 ─────────────────────────────────────────────────────

const allArgs = process.argv.slice(2);
const command = allArgs[0];
const commandArgs = allArgs.slice(1);

if (!command || command === '--help' || command === '-h') {
  console.log(`Usage: node run.js <command> [options]

Commands:
  init                          Environment setup
  get-device-token              Get device token
  get-token [--env test|prod]   Get cached user token
  auth-get-code [--env test|prod]  Get auth link
  auth-poll-token               Poll auth result
  qrcode <url> [client_id]      Generate QR code PNG
  issue --token <t>             Issue coupons
  hotword --city-id <id>        Hot search words
  search --keyword <kw> --lat <lat> --lng <lng> --token <t> --city-id <id>
  location --token <t>          Get recent location
  location-by-address --address <addr>  Get location by address
  order --product-id <pid> --poi-id <pid> --token <t> --city-id <id> --uuid <u>
  logout                        Logout
  clear-device-token            Clear device token`);
  process.exit(0);
}

if (!commands[command]) {
  fail('UNKNOWN_COMMAND', { command, available: Object.keys(commands) });
}

commands[command](commandArgs);
