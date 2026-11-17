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