# Windows 本地故障排查（M6）

状态：发布候选（Release Candidate）。遇到问题时，先运行 `scripts\check-installation.ps1`（只读，不会修改任何东西），它能自动发现下面大部分问题并打印具体的修复命令。本文档补充体检脚本之外、需要人工判断的场景。

## 1. 端口 8766 被占用

**现象**：`start-dashboard.ps1` 报错说端口被占用，或面板打不开。

**排查**：

```powershell
.\scripts\check-installation.ps1
```

体检脚本会区分两种情况：

* 端口上跑的**就是本项目**的面板服务（`/api/health` 能识别出来）——不用管，直接用现有的那个实例即可，浏览器打开 `http://127.0.0.1:8766` 就行。
* 端口被**别的程序**占用——两个办法：关掉那个占用端口的程序；或者给面板换个端口：

```powershell
$env:SITEMAP_DASHBOARD_PORT = 8899
.\scripts\start-dashboard.ps1
```

（`SITEMAP_DASHBOARD_PORT` 只对当前 PowerShell 会话生效；每次都要用新端口的话，考虑加进用户级环境变量。）

## 2. NODE_MODULE_VERSION 不匹配（ABI 127 / 137 冲突）

**现象**：启动面板或运行采集时报类似这样的错误：

```text
Error: The module '...\better-sqlite3\build\Release\better_sqlite3.node'
was compiled against a different Node.js version using
NODE_MODULE_VERSION 137. This version of Node.js requires
NODE_MODULE_VERSION 127.
```

**原因**：`node_modules` 里的 `better-sqlite3` 是原生模块，编译时绑定了当时用的 Node.js 版本的 ABI。127 对应 Node 22，137 对应 Node 24。如果先用 Node 24 跑过一次 `npm install`，再切回 Node 22 运行，就会出现这个错误（反过来也一样）。

**修复**：

```powershell
node --version   # 确认现在确实是 Node 22（v22.x.x）
Remove-Item -Recurse -Force node_modules
npm install
```

如果机器上同时装了多个 Node 版本，确认 `node` 命令解析到的是 Node 22（`Get-Command node`），必要时直接用完整路径调用，例如：

```powershell
& "D:\Tools\node-v22.23.1-win-x64\node.exe" bin\dashboard.js
```

## 3. better-sqlite3 加载失败（不是版本不匹配）

如果 `node -e "require('better-sqlite3')"` 报的不是 `NODE_MODULE_VERSION` 相关错误，常见原因：

* `node_modules` 没装全（`npm install` 中途失败或被打断）——重新执行一次 `npm install`。
* 项目目录路径里有极其特殊的字符导致某些工具链异常（正常的中文路径是支持的，`scripts/` 下的脚本和 `better-sqlite3` 都没有 ASCII-only 路径的限制）——如果怀疑是路径问题，可以先在一个纯英文短路径下试一次排除法。
* 杀毒软件隔离了 `.node` 二进制文件——检查杀毒软件的隔离区/日志。

## 4. `Get-Content` 读中文文件乱码

PowerShell 5.1 的 `Get-Content` 默认编码不是 UTF-8（不同 Windows 语言版本默认值不一样）。本项目所有配置/报告文件都是不带 BOM 的 UTF-8，读取时显式指定编码：

```powershell
Get-Content .\config\sites.csv -Encoding UTF8
Get-Content .\output\2026-07-15\<run_id>\report.md -Encoding UTF8
```

PowerShell 7 的 `Get-Content` 默认就是 UTF-8，这一步可以省略，但显式指定不会有副作用，建议保留习惯。

## 5. Git 更新代码后，旧的 Node 进程还在跑

**现象**：`git pull` 拉了新代码，重启面板后行为看起来还是旧的。

**原因**：面板服务是独立进程（`start-dashboard.ps1` 用 `Start-Process ... -WindowStyle Hidden` 启动），关闭 PowerShell 窗口不会停止它；`git pull` 也不会自动重启正在运行的服务。

**修复**：

```powershell
.\scripts\stop-dashboard.ps1
git pull
.\scripts\start-dashboard.ps1
```

如果 `stop-dashboard.ps1` 提示"没有检测到运行中的面板服务"，但任务管理器里还能看到 `node.exe` 进程占着 8766 端口——先用 `.\scripts\check-installation.ps1` 确认端口状态，再用任务管理器手工核对该进程的命令行（确认是不是本项目的 `bin\dashboard.js`）后再决定是否手工结束它；本项目的脚本不会替你杀死一个它自己不能确认身份的进程。

## 6. 备份/恢复被拒绝，或恢复失败

**现象 A**：运行 `backup-local-data.ps1` 报错"Sitemap 监控面板服务正在运行……拒绝备份"。

**原因**：**备份和恢复之前都必须先停止面板服务**。面板运行时数据库文件正被进程以 WAL 模式打开，直接用 `Copy-Item` 复制可能拿到一份不一致的快照——脚本发现面板在跑就直接拒绝，不会替你自动停止服务，也没有绕过这个检查的参数。

**修复**：

```powershell
.\scripts\stop-dashboard.ps1
.\scripts\backup-local-data.ps1
```

`restore-local-data.ps1` 同样要求面板服务未运行，报错时用同样的方法先停止服务再重试。

**现象 B**：运行 `restore-local-data.ps1` 报错"恢复后的数据库完整性检查未通过或无法执行"，恢复被回滚。

**原因**：只要这次恢复包含 `data\local.db`，恢复后跑一次 `PRAGMA integrity_check` 是**强制步骤，不能跳过**——找不到 Node.js、`better-sqlite3` 加载失败（常见于 NODE_MODULE_VERSION 不匹配，见第 2 节）、检查命令本身执行失败、或者检查结果不是 `ok`，都会被当成恢复失败，整体回滚到恢复前的状态（原本存在的文件换回旧内容，这次新建的文件会被删除）。

**修复**：先用 `.\scripts\check-installation.ps1` 排查 Node/ABI/better-sqlite3 是否正常（见第 2、3 节），确认环境没问题后再重新执行恢复。如果确认恢复源本身的 `data\local.db` 已经损坏，改用更早一份备份重试。

## 7. partial / failed 是什么意思

* **partial**：技术上有响应，但结果不完整或不可靠（比如 Sitemap 被截断、部分子 Sitemap 抓取失败、或者页面数是 0）。这次结果**不会**更新"新增/缺失/恢复"的比较基准，也不会污染历史数据。
* **failed**：这次采集完全没跑成功（网络错误、超时、目标站点整体不可达等）。同样不会更新历史。

两者的共同点：**只影响这一次运行的展示，不会覆盖或清空之前成功建立的历史**。对应站点这一轮的"缺失/连续两轮缺失/恢复"列会显示"未对比"，不是这次真的算出来的 0。

## 8. 怎么验证 AI 审查包 ZIP 本身没坏

```powershell
Expand-Archive -Path "output\2026-07-15\<run_id>\ai-review-package.zip" -DestinationPath "$env:TEMP\ai-review-check" -Force
Get-ChildItem "$env:TEMP\ai-review-check"
```

应该正好看到 12 个文件（`manifest.json`、`ai-review.json`、`ai-review.txt`、`report.md`、`new-urls.csv`、`new-urls.json`、`new-games.csv`、`unknown-urls.csv`、`missing-urls.csv`、`consecutive-missing-urls.csv`、`restored-urls.csv`、`changes.json`）。再确认 `manifest.json` 能被解析且 `includedFiles` 数组长度也是 12：

```powershell
(Get-Content "$env:TEMP\ai-review-check\manifest.json" -Encoding UTF8 | ConvertFrom-Json).includedFiles.Count
```
