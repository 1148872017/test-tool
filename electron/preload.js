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

  // ---- 回收站（软删除，30 天自动清理）----
  trashList: () => invoke('records:trash-list'),
  trashCount: () => invoke('records:trash-count'),
  trashRestore: (id) => invoke('records:trash-restore', { id }),
  trashPurge: (id) => invoke('records:trash-purge', { id }),
  trashClear: () => invoke('records:trash-clear'),
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
  importTemplate: (collection) => invoke('data:importTemplate', { collection }),
  exportDb: () => invoke('data:exportDb'),
  restoreBackup: (file) => invoke('backup:restore', { file }),

  // ---- 代码调试 ----
  runnerList: () => invoke('runner:list'),
  runnerRun: (payload) => invoke('runner:run', payload),
  runnerCancel: (runId) => invoke('runner:cancel', { runId }),
  runnerDetect: () => invoke('runner:detect'),
  projectsScan: (root) => invoke('projects:scan', { root }),
  projectsTestClasses: (dir) => invoke('projects:testClasses', { dir }),
  projectsPickDir: () => invoke('projects:pickDir'),
  runnerOpenBrowserDir: () => invoke('runner:openBrowserDir'),
  pickFile: (payload) => invoke('util:pickFile', payload),
  pickDir: (payload) => invoke('util:pickDir', payload),

  // ---- OpenAPI 文件直接解析 ----
  openapiPickFile: () => invoke('openapi:pickFile'),
  openapiParseFile: (file) => invoke('openapi:parseFile', { file }),

  // ---- JMeter 脚本生成 ----
  jmxgenPreview: (payload) => invoke('jmxgen:preview', payload),
  jmxgenSave: (payload) => invoke('jmxgen:save', payload),

  // ---- MySQL SQL 生成 ----
  sqlgenSnapshot: (payload) => invoke('sqlgen:snapshot', payload),
  sqlgenCleanup: (payload) => invoke('sqlgen:cleanup', payload),
  sqlgenRestore: (payload) => invoke('sqlgen:restore', payload),
  sqlgenListBackups: (tables) => invoke('sqlgen:listBackups', { tables }),
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
  codescanRules: () => invoke('codescan:rules'),
  codescanCoverage: (root, kind, modules, ruleIds) => invoke('codescan:coverage', { root, kind, modules, ruleIds }),
  codescanModules: (kind) => invoke('codescan:modules', { kind }),
  codescanHardcoded: (root, ruleIds) => invoke('codescan:hardcoded', { root, ruleIds }),
  codescanPickDir: () => invoke('codescan:pickDir'),
  codescanDeps: (root) => invoke('codescan:deps', { root }),

  // ---- 示例数据 ----
  dataGenFile: (payload) => invoke('data:genFile', payload),
  dataOpenWorkspace: (dir) => invoke('data:openWorkspace', { dir }),
  demoCount: () => invoke('demo:count'),
  demoClear: () => invoke('demo:clear'),
  demoPaths: () => invoke('demo:paths'),

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