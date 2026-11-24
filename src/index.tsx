/**
 * 正式入口：只做挂载。
 *
 * 这里**不装 mock**。浏览器预览走 src/index.preview.tsx（build.mjs --preview），
 * 产物在 dist/preview/，并被 package.json build.files 排除在安装包之外。
 */
import { mount } from './main';

mount();
