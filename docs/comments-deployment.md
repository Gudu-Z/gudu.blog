# 部署读者评论

博客继续由 GitHub Pages 提供静态页面，评论使用独立的 Waline 服务保存到数据库。读者填写昵称即可评论，邮箱选填，无需注册；新评论通过审核后才公开。

当前仓库只准备了接入代码，**还没有线上评论服务**。`content/comments.json` 的 `serverURL` 留空时，构建不会输出评论区，也不会加载评论客户端。

## 1. 创建 Waline 服务和数据库

仓库的 `services/comments/` 已准备好独立服务模板，固定使用 `@waline/vercel` 1.43.4，并包含昵称校验与默认审核配置。把该目录中的文件复制到一个单独的 GitHub 仓库，再从 Vercel 导入这个服务仓库；运行时选择 **Node.js 24.x**。也可以导入现有仓库，将 Vercel 的 **Root Directory** 指定为 `services/comments`。博客本身仍在 GitHub Pages 发布。

1. 在 Vercel 的 Waline 项目中打开 **Storage → Create Database**，选择 **Neon**，完成数据库连接。
2. 选择区域和套餐前查看当前额度、休眠规则与费用；本文不假定免费额度永久不变，也不要求购买付费套餐。
3. 打开 Neon 的 **SQL Editor**，在新建的空数据库执行官方 [waline.pgsql](https://github.com/walinejs/waline/blob/main/assets/waline.pgsql)。已有评论数据的数据库不要重复执行初始化脚本。
4. 回到 Vercel 重新部署，等待成功，记下正式服务的 HTTPS 地址。不要使用每次构建变化的预览地址。

Vercel 与 Neon 的连接流程参照 [Waline 官方快速开始](https://waline.js.org/en/guide/get-started/)。已有现成 Waline 服务时，可以跳过创建步骤，但需要合并本模板的校验和审核设置。

可以先使用服务的 `*.vercel.app` 正式地址，也可以在 Vercel 添加自己的评论子域名。添加域名时按控制台当前给出的 DNS 记录配置，待 HTTPS 可用后再继续。

## 2. 配置审核、频率限制和管理账号

在 Waline 项目的 **Settings → Environment Variables** 为 Production 设置以下变量。下表的 `你的服务域名` 必须替换为上一步实际获得的域名。

| 变量 | 值 | 作用 |
| --- | --- | --- |
| `SITE_NAME` | `Gudu 的个人博客` | 后台与通知中的站名 |
| `SITE_URL` | `https://gudu.blog` | 博客地址 |
| `SERVER_URL` | `https://你的服务域名` | Waline 正式服务地址 |
| `SECURE_DOMAINS` | `gudu.blog,你的服务域名` | 同时允许博客和评论管理页面；填写裸域名，不带协议、路径或空格 |
| `COMMENT_AUDIT` | `true` | 新评论须经管理员批准后公开 |
| `IPQPS` | `60` | 同一 IP 两次评论至少间隔 60 秒 |
| `DISABLE_USERAGENT` | `true` | 不向读者展示浏览器与系统信息 |
| `DISABLE_REGION` | `true` | 不向读者展示评论者地区 |
| `AKISMET_KEY` | `false` | 关闭向第三方 Akismet 发送评论进行自动反垃圾检测 |

模板默认使用 `LOGIN=disable`，不要改成 `force`；本站客户端也已关闭读者登录入口。默认防刷措施是人工审核和 IP 频率限制，未启用 Akismet 自动反垃圾服务。隐藏地区和浏览器展示不等于不保存 IP，IP 仍可能用于服务端防刷。环境变量修改后必须重新部署才能生效。可对照 `services/comments/.env.example` 填写，配置含义见 [服务端环境变量](https://waline.js.org/en/reference/server/env.html)。

服务和数据库就绪后，**立即访问 `https://你的服务域名/ui/register` 注册第一个管理员，再把服务地址接入博客或分享给读者**。Waline 将第一个注册用户设为管理员。之后通过 `/ui` 登录管理和审核评论。[官方管理说明](https://waline.js.org/en/guide/get-started/#comment-management-management)

`SECURE_DOMAINS` 是来源限制，不能替代审核、频率限制或验证码；Waline 默认还允许本机开发域名。本站另外阻止非正式博客域名连接线上评论，避免预览时误发真实评论。[服务端域名配置](https://waline.js.org/en/reference/server/config.html#securedomains)

## 3. 确认服务端校验

本站表单使用 `meta: ['nick', 'mail']`、`requiredMeta: ['nick']`、`login: 'disable'`，并设置前端评论长度上限为 1000。这个长度限制只控制正常读者的表单体验，服务端模板没有强制同一阈值，直接调用 API 可绕过前端长度限制。[客户端选项](https://waline.js.org/en/reference/client/props.html)

模板的 `index.cjs` 已将 `policy.cjs` 接入官方 `preSave(comment)` 钩子，在服务端拒绝空昵称、去掉昵称首尾空格，允许不填邮箱。这项定制仅增加昵称规则，正文处理仍由 Waline 负责。直接部署整个模板即可，无需另写昵称校验；服务升级时要保留入口和策略文件。使用已有 Waline 项目时，应合并这项服务端校验。[服务端钩子](https://waline.js.org/en/reference/server/config.html#presave-comment)

部署后分别验证 API 拒绝空昵称、昵称加正文且不填邮箱可提交；不能仅凭表单的星号或按钮状态判断昵称规则已在服务端生效。另行确认审核和频率限制生效，不把正文过滤等同于反垃圾保护。[评论安全机制](https://waline.js.org/en/guide/features/safety.html)

## 4. 接入博客

编辑博客的 `content/comments.json`，填入实际服务的根地址，不要附加 `/ui` 或 `/api`：

```json
{
  "serverURL": "https://你的服务域名",
  "turnstileKey": ""
}
```

这里只保存公开地址和可公开的验证码站点密钥；数据库密码、SMTP 密码及验证码 secret 只能保存在服务端。

本地使用 Node.js 22.12 或更新版本（建议与服务端统一使用 24.x），在博客目录运行：

```sh
npm ci
npm run build
npm run check
```

将配置、接入代码、本地客户端资源和生成的文章页一并提交发布。本站使用本地资源中的 Waline 3.16.1，靠近评论区时才加载客户端；没有评论服务地址时，不输出空表单。当前若没有正式文章，需先发布一篇真实文章才能在线上看到评论区。

评论按稳定的 `/posts/文章-slug.html` 区分，查询参数和章节锚点不会产生另一组评论。发布后不要随意更改文章 `slug`，否则新网址会对应另一组评论；重命名时需要同时迁移评论数据中的文章路径。

单篇不开放评论时，在文章开头的 YAML 中加上：

```yaml
comments: false
```

省略该字段时遵循全站配置。草稿没有公开阅读页；示例文章不连接评论。将全站 `serverURL` 改回空字符串并重新构建、发布，可以关闭全站评论入口，已有评论仍留在数据库。

## 5. 上线验证与日常管理

1. 在正式文章页填写昵称和正文，邮箱留空，确认可以提交并显示等待审核的反馈。
2. 使用另一个未登录的浏览器确认未审核内容没有公开；在 `/ui` 批准后刷新，确认读者能看到评论并回复。
3. 分别打开两篇文章，确认评论没有串页；给网址加查询参数或章节锚点，确认仍是同一组评论。
4. 在手机上检查表单、回复和分页。连续提交应受到服务端频率限制；断网时提交失败不能被显示成成功。
5. 本地预览或其他预览域名应显示预览提示，不访问线上评论。要在本地测试完整交互，应使用独立数据库和运行在 loopback 地址（如 `http://127.0.0.1:8360`）的隔离评论服务；当前前端不会连接远程测试部署。不要解除线上隔离后向真实文章灌入测试内容。

审核、删除和标记垃圾评论在 Waline `/ui` 中完成。昵称评论不验证真实身份，同名昵称不能证明是同一个人。

## 可选：验证码、邮件通知与备份

遇到灌水后，可以添加 Cloudflare Turnstile：在前端 `turnstileKey` 填入公开 site key，在服务端设置配套的 `TURNSTILE_KEY` 和 `TURNSTILE_SECRET`，同时配置允许使用该验证码的博客域名，然后重新部署并测试。Secret 不可写入博客配置。[Waline 验证码配置](https://waline.js.org/en/reference/server/env.html#safety)

邮箱选填并不表示已经开启通知。需要回复邮件时，再按邮件提供方配置 `SMTP_HOST`、`SMTP_PORT`、`SMTP_USER`、`SMTP_PASS`、`SMTP_SECURE` 及发件地址，部署后实测收信；未完成前不向读者承诺会收到邮件。[Waline 邮件通知](https://waline.js.org/en/guide/features/notification.html#email-notification)

评论数据保存在 Neon，Git 仓库的备份不包含评论。上线后定期将数据库导出到私有存储，服务升级或迁移前额外备份一次。Neon 支持通过 `pg_dump` 导出、`pg_restore` 恢复，使用 **direct / unpooled** 连接，并先在独立数据库验证恢复；备份可能包含邮箱、IP 和账号资料，不要提交到公开仓库。[Neon 数据库备份说明](https://github.com/neondatabase/website/blob/main/content/docs/manage/backup-pg-dump.md)
