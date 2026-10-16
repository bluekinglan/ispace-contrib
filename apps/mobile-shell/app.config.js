/**
 * 在 `app.json` 之上叠一层构建期配置。
 *
 * Expo 读到 `app.config.js` 时会先把 `app.json` 解析好传进来（参数里的 `config`），
 * 这里只覆盖那些**必须随部署实例变化**的字段。静态的部分（图标、权限文案、
 * 插件列表）仍然留在 `app.json`，那才是它该待的地方。
 *
 * 为什么这些非得在构建期定：它们全是原生层配置——`updates.url` 编译进
 * Expo Updates 的原生模块，明文 HTTP 开关写进 AndroidManifest 与 Info.plist。
 * 改 JS 不生效，必须重新出壳。
 *
 * 可设的环境变量见仓库根目录 `.env.example`。
 */

const RAW_BASE = process.env.EXPO_PUBLIC_ISPACE_BASE_URL ?? 'http://localhost:3100';
const BASE = RAW_BASE.replace(/\/+$/, '');

/**
 * 明文 HTTP 只在**确实连着 http:// 实例**时才打开。
 *
 * 安卓 9 起默认禁止应用发起明文请求，iOS 的 ATS 同理，而两者的失败方式都
 * 极具迷惑性：浏览器里一切正常，壳自己的每个 fetch 被系统直接掐断，界面上
 * 没有任何报错，表现只是「点了没反应」。详见 CLEARTEXT.md。
 *
 * 所以内网 HTTP 部署需要它。但把它无条件写死，等于让所有公网 HTTPS 部署也
 * 白白放开明文——那是实打实的降级。跟着地址走，两种形态各自拿到对的配置。
 */
const ALLOW_CLEARTEXT = BASE.startsWith('http://');

/**
 * 应用标识。换成你自己的反向域名。
 *
 * 注意它同时是**更新与覆盖安装的身份**：改了这个值，商店和系统就认为这是
 * 另一个 App，既有安装不会收到更新，只能重装。所以一个实例一旦发出去过，
 * 就别再改了。
 *
 * ┌─ 为什么没有默认值 ────────────────────────────────────────────────┐
 * │ 这里原本是 `?? 'com.example.ispace'`。一个「发出去就不能再改」的      │
 * │ 身份配上静默默认值，失败方式是这样的：某人在没设这个变量的机器上跑   │
 * │ 一次 prebuild，包名悄悄变成 com.example.ispace，构建、上传、发布全部  │
 * │ 正常，没有任何报错——直到同事点「更新」时装不上去，才发现手上这版和   │
 * │ 线上那版在系统看来是两个 App，只能卸载重装。                        │
 * │                                                                    │
 * │ 这种错不该靠人记得导出环境变量来避免。缺了就当场停下，比事后让所有   │
 * │ 人重装便宜得多。                                                    │
 * └────────────────────────────────────────────────────────────────────┘
 */
const APP_ID = process.env.ISPACE_APP_ID;
if (!APP_ID) {
  throw new Error(
    '缺少 ISPACE_APP_ID：它是 App 的身份（更新与覆盖安装都认它），没有默认值。\n'
    + '  本机临时用：export ISPACE_APP_ID=com.yourcompany.ispace\n'
    + '  长期用：写进仓库根目录的 .env（见 .env.example），再 set -a; . ./.env; set +a\n'
    + '  ⚠️ 这个实例已经发出去过包的话，必须沿用原值，换了等于发了一个新 App。',
  );
}

module.exports = ({ config }) => ({
  ...config,
  updates: {
    ...config.updates,
    url: `${BASE}/updates/manifest`,
  },
  ios: {
    ...config.ios,
    bundleIdentifier: APP_ID,
    infoPlist: {
      ...config.ios?.infoPlist,
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: ALLOW_CLEARTEXT },
    },
  },
  android: {
    ...config.android,
    package: APP_ID,
  },
  plugins: (config.plugins ?? []).map((p) =>
    Array.isArray(p) && p[0] === 'expo-build-properties'
      ? [p[0], { ...p[1], android: { ...p[1]?.android, usesCleartextTraffic: ALLOW_CLEARTEXT } }]
      : p,
  ),
  extra: {
    ...config.extra,
    ispace: { apiBase: BASE, updatesBase: `${BASE}/updates` },
  },
});
