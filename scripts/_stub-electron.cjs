/* 测试用的 electron stub：只提供 updater.js 需要的最小接口 */
module.exports = {
  app: {
    getVersion: () => '0.0.1',
    getPath: (name) => {
      const os = require('os');
      const path = require('path');
      if (name === 'temp') return os.tmpdir();
      return path.join(os.tmpdir(), 'test-tool-stub');
    }
  },
  shell: {
    openPath: async () => ''
  }
};
