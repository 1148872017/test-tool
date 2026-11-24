'use strict';
/**
 * shared-helpers.js —— 多个 IPC 域共用的后端辅助逻辑。
 *
 * 从 main.js 搬迁而来，行为与搬迁前完全一致。
 * 这几个函数被 3 个以上的域用到（app / settings / jmx / jmxgen / jtl），
 * 放这里而不是塞进某一个域，避免域与域之间互相 require。
 *
 * 注意：settings 是 main.js 里的活对象（loadSettings() 会整体替换），
 * 所以这里一律由调用方传进来，**不在本模块里缓存**。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function publicSettings(settings) {
  return {
    projectDir: settings.projectDir || '',
    javaHome: settings.javaHome || '',
    pythonPath: settings.pythonPath || '',
    mvnPath: settings.mvnPath || '',
    themeColor: settings.themeColor || 'purple',
    bgImage: settings.bgImage || '',
    bgOpacity: settings.bgOpacity === undefined ? 85 : settings.bgOpacity,
    bgTextMode: settings.bgTextMode || 'auto',
    bgOverlay: settings.bgOverlay === undefined ? 35 : settings.bgOverlay,
    bgOverlayColor: settings.bgOverlayColor === 'light' ? 'light' : 'dark',
    autoLockMinutes: settings.autoLockMinutes,
    clipboardClearSeconds: settings.clipboardClearSeconds,
    openCopyPassword: settings.openCopyPassword !== false,
    closeAction: settings.closeAction === 'quit' ? 'quit' : 'tray',
    workspaceDir: settings.workspaceDir || '',
    casesDir: settings.casesDir || '',
    jmxDir: settings.jmxDir || '',
    reportDir: settings.reportDir || '',
    allureDir: settings.allureDir || '',
    kbDir: settings.kbDir || '',
    notesDir: settings.notesDir || '',
    jmeterPath: settings.jmeterPath || '',
    hasPin: !!settings.pin
  };
}

/**
 * 探测 JMeter。优先级：
 *   1. 设置里存的路径
 *   2. 环境变量 JMETER_HOME（指向 JMeter 安装目录，不是 bin）
 *   3. PATH 里的 jmeter
 *   4. 常见安装位置（兜底，不保证存在）
 * 探测到就写回设置，否则设置页永远显示空、用户以为没生效。
 */
function detectJmeter(settings, saveSettings) {
  const candidates = [];
  if (settings.jmeterPath) candidates.push(settings.jmeterPath);

  // 环境变量：JMETER_HOME 指向安装目录
  const home = process.env.JMETER_HOME;
  if (home) {
    candidates.push(path.join(home, 'bin', 'jmeter.bat'));
    candidates.push(path.join(home, 'bin', 'jmeter'));
  }

  // PATH 里的 jmeter（Windows 上可能是 .bat 或 .cmd）
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    candidates.push(path.join(dir, 'jmeter.bat'));
    candidates.push(path.join(dir, 'jmeter.cmd'));
  }

  // 常见安装位置兜底
  for (const drive of ['C:', 'D:', 'E:']) {
    for (const ver of ['5.6.3', '5.5', '5.4.3']) {
      candidates.push(path.join(drive + path.sep, `apache-jmeter-${ver}`, 'bin', 'jmeter.bat'));
    }
  }

  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      if (settings.jmeterPath !== c) {
        settings.jmeterPath = c;
        try {
          saveSettings();
        } catch (err) {
          /* 存不下也不影响本次使用 */
        }
      }
      return c;
    }
  }
  return '';
}

/**
 * 读 JMeter 版本（不启动 JMeter）。
 * jar 名不带版本号，所以依次试：目录名 → jmeter.properties 里的注释 → jar 的 MANIFEST。
 */
function jmeterVersionOf(batPath) {
  try {
    const home = path.dirname(path.dirname(batPath));
    // 1) 目录名里通常带版本：apache-jmeter-5.4.3
    const m = /jmeter[-_]?([\d]+\.[\d]+(?:\.[\d]+)?)/i.exec(path.basename(home));
    if (m) return m[1];

    // 2) jmeter.properties 顶部注释
    const propsFile = path.join(home, 'bin', 'jmeter.properties');
    if (fs.existsSync(propsFile)) {
      const head = fs.readFileSync(propsFile, 'utf8').slice(0, 2000);
      const pm = /jmeter[- ]?([\d]+\.[\d]+(?:\.[\d]+)?)/i.exec(head);
      if (pm) return pm[1];
    }

    // 3) jar 的 MANIFEST.MF（zip 里找 Implementation-Version）
    const jar = path.join(home, 'lib', 'ext', 'ApacheJMeter_core.jar');
    if (fs.existsSync(jar)) {
      const buf = fs.readFileSync(jar);
      const text = buf.toString('latin1');
      const vm = /Implementation-Version:\s*([\d.]+)/.exec(text);
      if (vm) return vm[1];
    }
    return '';
  } catch (e) {
    return '';
  }
}

/**
 * 启动 JMeter。
 *
 * Windows 上**不能直接 spawn 一个 .bat**：Node 从 CVE-2024-27980 修复后
 * 禁止直接执行批处理文件，会抛 EINVAL。必须走 shell:true（或 cmd /c）。
 * 用 shell:true 时路径里有空格/中文要自己加引号，否则会被拆成多个参数。
 */
function launchJmeter(settings, saveSettings, jmxFile) {
  const bat = detectJmeter(settings, saveSettings);
  if (!bat) {
    return {
      ok: false,
      code: 'JMETER_NOT_FOUND',
      message: '没找到 JMeter。请到「设置 → 压测」里点「选择…」指定 jmeter.bat 的路径（通常在 JMeter 安装目录的 bin 下）'
    };
  }
  if (jmxFile && !fs.existsSync(jmxFile)) {
    return { ok: false, code: 'JMX_NOT_FOUND', message: '脚本文件不存在：' + jmxFile };
  }

  const quoted = '"' + bat + '"';
  const args = jmxFile ? ['-t', '"' + jmxFile + '"'] : [];
  const cmd = [quoted].concat(args).join(' ');

  try {
    const child = spawn(cmd, {
      cwd: path.dirname(bat),
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      shell: true
    });
    child.on('error', (err) => {
      console.error('[jmeter] spawn error', err);
    });
    child.unref();
    return { ok: true, jmeter: bat, version: jmeterVersionOf(bat), command: cmd };
  } catch (err) {
    const code = (err && err.code) || '';
    let message = (err && err.message) || '启动 JMeter 失败';
    if (code === 'EINVAL') {
      message = '启动失败（EINVAL）：Windows 不允许直接执行 .bat，已改用 shell 方式；如果仍失败请检查路径是否含特殊字符';
    } else if (code === 'ENOENT') {
      message = '启动失败：找不到 ' + bat + '，请到设置里重新指定';
    } else if (code === 'EACCES') {
      message = '启动失败：没有执行权限，' + bat;
    }
    return { ok: false, code, message };
  }
}

module.exports = { publicSettings, detectJmeter, jmeterVersionOf, launchJmeter };