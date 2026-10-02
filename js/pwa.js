// 可安装性接线。为什么单独一个文件：注册 service worker 是这段代码里唯一会在某些协议下
// 直接抛异常的动作，而一条未捕获的 rejection 会把整个模块图带下水（file:// 打开 index.html
// 是真实用法：Electron 之外的本地双击）。

// Electron 的打包入口走的是 file://，Pages 走 https，verify.sh 走 http://127.0.0.1
// （回环地址算安全上下文）。只有后两种能注册。
const REGISTRABLE = () => location.protocol === 'http:' || location.protocol === 'https:';

export function registerServiceWorker() {
  if (!REGISTRABLE()) return null;
  const nav = typeof navigator === 'object' ? navigator : null;
  if (!nav || !nav.serviceWorker || typeof nav.serviceWorker.register !== 'function') return null;
  // scope 显式写成当前目录：Pages 把这个仓发在 /z-biz-game-slant-cos/ 之下，
  // 不写 scope 会继承 sw.js 的目录，看起来一样，但根形态与前缀形态的差别就在这里。
  return nav.serviceWorker.register('./sw.js', { scope: './' }).catch(() => null);
}

// 装不装得上，玩家看不见"beforeinstallprompt"这类事件名，只看得见"加到主屏幕"有没有出现。
// 把它挂到 window 上，浏览器闸可以复验注册确实发生了，而不是只写了字符串。
export function installPromptSurface(win = globalThis) {
  if (!win || !win.addEventListener) return null;
  let deferred = null;
  win.addEventListener('beforeinstallprompt', (ev) => {
    ev.preventDefault();
    deferred = ev;
  });
  win.slantPwa = {
    get canPrompt() {
      return !!deferred;
    },
    prompt() {
      if (!deferred) return Promise.resolve(null);
      const p = deferred;
      deferred = null;
      return p.prompt().then(() => p.userChoice).catch(() => null);
    },
  };
  return win.slantPwa;
}
