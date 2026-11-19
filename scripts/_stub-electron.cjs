/* 测试用的 electron stub：提供 updater.js 需要的最小接口 */
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
  },
  // net 在纯 Node 里不可用，测试只验证「调用不崩」，不验证真实网络
  net: {
    request: () => {
      const handlers = {};
      const req = {
        setHeader: () => {},
        on: (ev, fn) => {
          handlers[ev] = fn;
          return req;
        },
        end: () => {
          // 模拟网络错误，让 checkUpdate 走 catch 分支
          setTimeout(() => {
            if (handlers.error) handlers.error(new Error('stub: 无网络'));
          }, 0);
        },
        abort: () => {}
      };
      return req;
    }
  }
};
