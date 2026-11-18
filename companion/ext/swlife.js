// 新后台一装好就接手，不等旧的（决策 EXT-2）。
// 伴随扩展换了版本，内核把新后台装成“等待中”，要等旧后台管着的扩展页面（新标签页、设置页…）全关掉才换上——
// 而实例启动时总会恢复出一个新标签页，于是更新后的头一次启动里后台谁也不在：图标不刷新、网页发来的消息没人收
// （实测，scripts/sw-upgrade-e2e.mjs 有对照）。skipWaiting 让新后台立刻换上，claim 把已经开着的页面接过来。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
