'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('api', {
  init: () => invoke('app:init'),
  lock: () => invoke('app:lock'),
  unlock: (pin) => invoke('app:unlock', { pin }),
  setPin: (oldPin, pin) => invoke('pin:set', { oldPin, pin }),
  clearPin: (pin) => invoke('pin:clear', { pin }),

  settings: () => invoke('settings:get'),
  saveSettings: (patch) => invoke('settings:set', patch),

  records: (collection, opts) => invoke('records:list', Object.assign({ collection }, opts)),
  record: (id) => invoke('records:get', { id }),
  saveRecord: (record) => invoke('records:save', record),
  removeRecord: (id) => invoke('records:remove', { id }),
  counts: () => invoke('records:counts'),

  copy: (text, secret) => invoke('clipboard:copy', { text, secret: !!secret }),
  hash: (algo, text) => invoke('util:hash', { algo, text }),
  openUrl: (url) => invoke('shell:open', { url }),

  backupNow: () => invoke('backup:now'),
  backups: () => invoke('backup:list'),
  openDataDir: () => invoke('data:openDir'),
  clearData: (target) => invoke('data:clear', { target }),
  getOptions: () => invoke('options:get'),
  saveOptions: (key, items) => invoke('options:save', { key, items }),
  exportData: (includeSecrets, collection) => invoke('data:export', { includeSecrets: !!includeSecrets, collection }),
  importData: (collection) => invoke('data:import', { collection }),
  exportDb: () => invoke('data:exportDb'),
  restoreBackup: (file) => invoke('backup:restore', { file }),

  // ---- 代码调试 ----
  runnerList: () => invoke('runner:list'),
  runnerRun: (payload) => invoke('runner:run', payload),
  runnerCancel: (runId) => invoke('runner:cancel', { runId }),
  projectsScan: (root) => invoke('projects:scan', { root }),
  projectsTestClasses: (dir) => invoke('projects:testClasses', { dir }),
  projectsPickDir: () => invoke('projects:pickDir'),
  runnerOpenBrowserDir: () => invoke('runner:openBrowserDir'),
  pickFile: (payload) => invoke('util:pickFile', payload),

  // ---- 代码骨架生成 ----
  codegenTargets: () => invoke('codegen:targets'),
  codegenPreview: (payload) => invoke('codegen:preview', payload),
  codegenSave: (payload) => invoke('codegen:save', payload),

  // ---- 皮肤 ----
  skinPickImage: () => invoke('skin:pickImage'),
  skinClearImage: () => invoke('skin:clearImage'),
  skinGetImage: () => invoke('skin:getImage'),

  // ---- Allure 报告 ----
  allureScan: (root) => invoke('allure:scan', { root }),
  allurePickDir: () => invoke('allure:pickDir'),
  allureParse: (dir) => invoke('allure:parse', { dir }),
  allureFlaky: (dirs) => invoke('allure:flaky', { dirs }),

  // ---- 代码扫描 ----
  codescanCoverage: (root) => invoke('codescan:coverage', { root }),
  codescanHardcoded: (root) => invoke('codescan:hardcoded', { root }),
  codescanPickDir: () => invoke('codescan:pickDir'),

  /** 订阅代码运行输出（返回取消订阅函数） */
  onRunnerOutput: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('runner:output', handler);
    return () => ipcRenderer.removeListener('runner:output', handler);
  },
  onRunnerExit: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('runner:exit', handler);
    return () => ipcRenderer.removeListener('runner:exit', handler);
  },
  caseScan: (root) => invoke('cases:scan', { root }),
  caseOpen: (file) => invoke('cases:openFile', { file }),
  caseReveal: (file) => invoke('cases:reveal', { file }),
  casePickDir: () => invoke('cases:pickDir'),

  jmxScan: (root) => invoke('jmx:scan', { root }),
  jmxOpenFile: (file) => invoke('jmx:openFile', { file }),
  jmxReveal: (file) => invoke('jmx:reveal', { file }),
  jmxOpenGui: (file) => invoke('jmx:openGui', { file }),
  jmxLaunch: () => invoke('jmx:launch'),
  jmxPickDir: () => invoke('jmx:pickDir'),
  jmxPickJmeter: () => invoke('jmx:pickJmeter'),

  reportScan: (root) => invoke('report:scan', { root }),
  reportPick: () => invoke('report:pick'),
  reportParse: (dir) => invoke('report:parse', { dir }),
  reportPickDir: () => invoke('report:pickDir'),

  kbScan: (root) => invoke('kb:scan', { root }),
  kbOpenFile: (file) => invoke('kb:openFile', { file }),
  kbReveal: (file) => invoke('kb:reveal', { file }),
  kbPickDir: () => invoke('kb:pickDir'),

  notesScan: (root) => invoke('notes:scan', { root }),
  notesOpenFile: (file) => invoke('notes:openFile', { file }),
  notesReveal: (file) => invoke('notes:reveal', { file }),
  notesPickDir: () => invoke('notes:pickDir'),
  notesPickImport: () => invoke('notes:pickImport'),
  notesImport: (files, onConflict) => invoke('notes:import', { files, onConflict }),

  updateCheck: (force) => invoke('update:check', { force }),
  updateDownload: (asset) => invoke('update:download', { asset }),
  updateCancel: () => invoke('update:cancel'),
  updateCleanup: () => invoke('update:cleanup'),
  updateInstall: (file) => invoke('update:install', { file }),
  onUpdateProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('update:progress', handler);
    return () => ipcRenderer.removeListener('update:progress', handler);
  },

  syncOpenApi: (file) => invoke('apis:sync', { file }),
  lastSyncChanges: () => invoke('apis:lastSync'),

  linksForApi: (apiId) => invoke('links:forApi', { apiId }),
  linksForCase: (filePath, caseTitle) => invoke('links:forCase', { filePath, caseTitle }),
  linkCounts: () => invoke('links:counts'),
  linkSave: (apiId, targets) => invoke('links:save', { apiId, targets }),
  linkAdd: (payload) => invoke('links:add', payload),
  linkRemove: (id) => invoke('links:remove', { id }),
  linkPrune: () => invoke('links:prune'),

  info: () => invoke('app:info')
});