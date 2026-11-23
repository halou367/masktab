// 内置扩展的实验接口（父进程里运行，有特权；decisions A-21）。
// 时区：Gecko 自带按浏览上下文的时区覆盖（BrowsingContext.timezoneOverride，WebDriver BiDi 的 emulation.setTimezoneOverride 用的就是它），
// 设在标签页的顶层浏览上下文上：之后这个标签页里新建的每个文档（含内嵌框架）和它们开的 Worker / SharedWorker 都按这个时区，
// Date 的构造、按本地时间解析字符串、Intl 默认时区都对（页面里的 JS 改写做不到这些）。Service Worker 不跟（内核还不支持；我们也没开 SW）。
// 只有特权代码能设：GeckoView 用 ensureBuiltIn 装的内置扩展是特权扩展（安装位置是 builtin），可以声明 experiment_apis（Fenix 的 webcompat 扩展同样做法）。
/* global ExtensionAPI */
'use strict';
this.mtEmu = class extends ExtensionAPI {
  getAPI(context) {
    const { tabManager } = context.extension;
    return {
      mtEmu: {
        async setTimezone(tabId, tz) {
          const tab = tabManager.get(tabId, null);
          const bc = tab && tab.browser && tab.browser.browsingContext;
          if (!bc) return null; // 标签页已经关了或还没有浏览上下文
          const top = bc.top || bc;
          if (top.timezoneOverride !== tz) top.timezoneOverride = tz;
          return top.timezoneOverride;
        },
      },
    };
  }
};
