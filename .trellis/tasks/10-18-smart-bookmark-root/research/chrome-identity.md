# Chrome 账号信息来源研究

## 结论

扩展使用 `chrome.identity.getProfileUserInfo()` 获取当前 Chrome 配置文件的主账号信息。该 API 返回 `email` 和稳定的 `id`，不返回 Google 账号的显示名称。

Manifest 需要声明 `identity.email` 权限。未登录、账号信息不可用或返回空字符串时，扩展不能从其他账号接口或网页读取名称，应直接使用 `bookmark` 回退值。

实现只使用邮箱 `@` 前的本地部分作为目录名：

```text
email: yuan@example.com
根目录: yuan 的智能书签

email: 空
根目录: bookmark 的智能书签
```

调用位置放在 Background Service Worker 的首次安装/启动初始化流程，结果只用于生成 Chrome 原生书签文件夹名称，不写入独立账号数据。

## 参考

- Chrome Extensions Identity API：<https://developer.chrome.com/docs/extensions/reference/api/identity>
- `getProfileUserInfo()` 方法说明：<https://developer.chrome.com/docs/extensions/reference/api/identity#method-getProfileUserInfo>

## 边界

- 不申请 OAuth scope，不建立账号登录流程。
- 不读取网页正文，不增加网页访问权限。
- 邮箱本地部分仅作为展示名称；根目录 ID 仍以 Chrome Bookmarks API 返回的 `id` 为唯一标识。
