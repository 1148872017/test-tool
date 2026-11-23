'use strict';
/**
 * 运行器配置：每种语言/框架怎么跑。
 *
 * 抽象：`{ cmd, args, cwd }` —— runner.js 只负责 spawn 和捕获输出。
 *
 * 加新语言只要在这里加一项。
 */

const path = require('path');

/**
 * @typedef {object} RunContext
 * @property {string} java java 路径
 * @property {string} python python 路径
 * @property {string} mvn mvn 路径
 * @property {string} jmeter JMeter 目录
 * @property {string} projectDir 项目目录
 * @property {string} file 脚本文件（groovy/python 用）
 * @property {string} testClass 测试类名（maven 用）
 * @property {string} code 代码内容（临时文件模式）
 */

const RUNNERS = {
  groovy: {
    key: 'groovy',
    label: 'Groovy（JMeter）',
    desc: '用 JMeter 自带的 Groovy 跑脚本，适合调断言/前置处理器',
    ext: '.groovy',
    /** 需要哪些环境 */
    needs: ['java', 'jmeter'],
    /**
     * 构造命令。
     * JMeter 的 jar 在 {jmeter}/lib/ 下，用 java -cp 跑 GroovyMain。
     */
    build(ctx) {
      if (!ctx.java) return { error: '找不到 java，请先装 JDK' };
      if (!ctx.jmeter) return { error: '找不到 JMeter，请在「设置 → 压测」里配路径' };
      const libDir = path.join(ctx.jmeter, 'lib');
      // Windows 的 classpath 分隔符是 ;
      const cp = path.join(libDir, '*');
      if (!ctx.file) return { error: '没有脚本文件' };
      return {
        cmd: ctx.java,
        args: ['-Dfile.encoding=UTF-8', '-cp', cp, 'groovy.ui.GroovyMain', ctx.file],
        cwd: ctx.projectDir || path.dirname(ctx.file)
      };
    }
  },

  python: {
    key: 'python',
    label: 'Python',
    desc: '直接跑 Python 脚本',
    ext: '.py',
    needs: ['python'],
    build(ctx) {
      if (!ctx.python) return { error: '找不到 python，请先装 Python' };
      if (!ctx.file) return { error: '没有脚本文件' };
      return {
        cmd: ctx.python,
        args: ['-X', 'utf8', ctx.file],
        cwd: ctx.projectDir || path.dirname(ctx.file)
      };
    }
  },

  pytest: {
    key: 'pytest',
    label: 'Python（pytest）',
    desc: '用 pytest 跑测试文件，输出更结构化',
    ext: '.py',
    needs: ['python'],
    build(ctx) {
      if (!ctx.python) return { error: '找不到 python，请先装 Python' };
      if (!ctx.file) return { error: '没有脚本文件' };
      return {
        cmd: ctx.python,
        args: ['-X', 'utf8', '-m', 'pytest', ctx.file, '-v', '--tb=short'],
        cwd: ctx.projectDir || path.dirname(ctx.file)
      };
    }
  },

  maven: {
    key: 'maven',
    label: 'Java（Maven）',
    desc: '跑 Maven 项目的测试类（TestNG / JUnit / Playwright / REST Assured 都走这个）',
    ext: null, // 跑整个项目，不是单个文件
    needs: ['mvn', 'java'],
    build(ctx) {
      if (!ctx.mvn) return { error: '找不到 mvn，请先装 Maven' };
      if (!ctx.projectDir) return { error: '请选择项目' };
      const args = ['-q', 'test'];
      if (ctx.testClass) args.push(`-Dtest=${ctx.testClass}`);
      // 跳过 javadoc/checkstyle 等，只跑测试
      args.push('-DfailIfNoTests=false');
      return {
        cmd: ctx.mvn,
        args,
        cwd: ctx.projectDir
      };
    }
  }
};

/** 运行器列表（给前端下拉用） */
function listRunners() {
  return Object.values(RUNNERS).map((r) => ({
    key: r.key,
    label: r.label,
    desc: r.desc,
    ext: r.ext,
    needs: r.needs
  }));
}

module.exports = { RUNNERS, listRunners };
