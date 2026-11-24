/**
 * 浏览器预览入口（`node scripts/build.mjs --preview` 专用）。
 *
 * 顺序很重要：先装内存实现（把 window.api 顶上），再 mount；
 * platform/api 是 Proxy 惰性取值的，所以 mount 之后也能拿到刚装好的 mock。
 *
 * 这个文件不进生产包：产物是 dist/preview/preview.js，
 * package.json 的 build.files 里有 "!dist/preview/**" 排除。
 */
import { installMockIfNeeded } from './mockApi';
import { mount } from './main';

installMockIfNeeded();
mount();
