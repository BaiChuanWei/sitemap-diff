# Sitemap 监控本地控制面板 —— 本地验收清单（M2）

状态：已实现。本文档给出在真实 Windows 环境上验证站点管理功能的具体步骤，以及配置出问题时的备份/恢复/回滚方法。

## 1. 启动前准备

```powershell
cd <项目目录>
npm install
npm test
```

`npm test` 应显示全部通过（本阶段基准：298/298）。如果测试不通过，不要继续验收——先解决测试失败，配置写入功能的正确性依赖这些测试覆盖的行为。

## 2. 启动面板

```powershell
.\scripts\start-dashboard.ps1
```

或者双击 `create-desktop-shortcuts.ps1` 生成的桌面快捷方式，或运行 `run-and-open-dashboard.ps1`（启动后自动打开默认浏览器）。

确认：
- 终端显示监听地址为 `http://127.0.0.1:8766`（或 `SITEMAP_DASHBOARD_PORT` 指定的端口）。
- 浏览器打开后能看到"Sitemap 监控面板"标题和"总览 / 站点管理"两个 tab。
- 页脚提示"本地专用面板，仅监听 127.0.0.1，不对局域网或公网开放"。

## 3. 站点管理黄金路径验收

按顺序操作，每一步都应该在浏览器里立刻看到对应反馈，不需要手工刷新页面（除非该步骤本身说明需要）：

1. **切到"站点管理" tab**：应看到 `config/sites.csv` 里已有的站点列表。
2. **新增站点**：点"+ 新增站点"，填 `site_id`（如 `testsite`）、`domain`（如 `testsite.example.com`），点"下一步：预览"，确认预览框里显示的 JSON 和你填写的一致，点"确认保存"。应看到"保存成功"提示，返回列表后能看到新站点。
3. **核对 CSV**：用文本编辑器打开 `config/sites.csv`，确认新增的一行确实写进去了，格式正确。
4. **编辑站点**：点新站点的"查看/编辑"，再点"编辑"，改一下"优先级"，预览、确认保存，确认列表里优先级更新了。
5. **站点级限制**：在站点详情页找到"站点级限制"区域，填一个 `max_download_bytes`（如 `10485760`），确认下方出现"约 10.0 MB"这样的可读换算，点"保存限制"。确认 `config/site-limits.csv` 里出现对应行。
6. **手工 Sitemap**：在"手工 Sitemap"区域点"+ 添加 Endpoint"，填一个合法的 `https://` 地址，点"保存手工 Sitemap"。确认 `config/site-sitemaps.csv` 里出现对应行。
7. **运行诊断**：点"运行诊断"，等待（可能需要几秒到几十秒，取决于站点大小），确认结果表格展示 discovery mode / 首页状态 / robots.txt 状态 / Endpoint 数量 / 推荐处理等字段。
8. **暂停监控**：回到详情页，点"暂停监控"，确认弹窗提示"暂停不会删除任何历史数据"，点确定。确认站点仍出现在列表中（标记为"暂停"），不是消失。
9. **恢复监控**：点"启用监控"，确认状态恢复。

## 4. 边界场景验收

| 场景 | 操作 | 期望结果 |
|---|---|---|
| 重复 site_id | 新增一个和已有站点相同的 site_id | 保存时提示字段错误，不会静默创建重复行 |
| 非法域名 | domain 填 `localhost` 或 `192.168.1.1` | 保存时提示域名不合法（SSRF 防护） |
| 手工编辑 CSV 后再从面板保存 | 面板打开着，用文本编辑器直接改 `sites.csv` 并保存，再回到面板尝试保存任意改动 | 面板保存时提示"配置已被其他操作修改，请刷新后重试"，不会覆盖手工编辑的内容；刷新面板页面后手工编辑的内容应该能看到 |
| 两个浏览器标签页同时编辑同一站点 | 开两个标签页，都打开同一站点的编辑表单并预览，其中一个先保存 | 先保存的成功；后保存的收到冲突提示，不会覆盖前者 |
| manual_only 模式下清空所有 Endpoint | 手工 Sitemap 模式选 `manual_only`，删掉所有已启用的 Endpoint 后保存 | 拒绝保存并提示"必须至少有一个已启用且合法的手工 Sitemap Endpoint" |

## 5. 备份与恢复

每一次成功的配置写入之前，服务都会在 `config/backups/<时间戳>-<随机后缀>/` 下保留修改前三份 CSV 文件的完整副本，附一个 `manifest.json` 记录每个文件写入前的哈希。

**手工恢复到某次写入之前的状态**：

```powershell
# 1. 先停止面板服务（Ctrl+C 或 stop-dashboard.ps1）
# 2. 找到要恢复的备份目录（按时间戳挑选）
dir config\backups
# 3. 把该目录下的文件复制回 config/，覆盖当前文件
copy config\backups\<时间戳目录>\sites.csv config\sites.csv
copy config\backups\<时间戳目录>\site-limits.csv config\site-limits.csv
copy config\backups\<时间戳目录>\site-sitemaps.csv config\site-sitemaps.csv
# 4. 重新启动面板——启动时会自动把 CSV 内容同步进 SQLite
.\scripts\start-dashboard.ps1
```

注意：如果某次备份的 `manifest.json` 里某个文件 `existedBefore: false`，说明写入前那个文件本来就不存在（比如第一次给某站点设置手工限制之前，`site-limits.csv` 还没被创建过）——恢复到那次备份之前的状态意味着删除该文件，而不是用备份目录里的内容覆盖（备份目录里也不会有这个文件）。

## 6. 已知残余风险（验收时应知晓，不代表验收失败）

以下场景是本里程碑明确记录、未完全解决的残余风险，详见 `dashboard-security.md` 第 7 节和 `dashboard-threat-model.md`：

- SSRF 防护只在保存配置时做静态检查，不含 DNS 解析和 HTTP 重定向时的运行时校验。
- 三份 CSV 文件的写入不是跨文件原子的：如果进程在写入过程中被强制杀死（断电、任务管理器强制结束），可能残留"部分文件已更新、部分文件还是旧内容"的中间态，需要按第 5 节手工用备份恢复。
- Windows 下如果 `sites.csv` 被 Excel 等程序独占打开，保存可能失败（会返回明确的错误提示，不会损坏文件），需要先关闭占用的程序再重试。

## 7. 回滚方法（整个 M2 功能）

如果需要临时回退到 M1（只读面板，无站点管理写功能）：

```powershell
git log --oneline  # 找到 M0+M1 完成时的 commit（本文档基准 440dcfe）
git checkout <M0+M1的commit> -- src/dashboard public/dashboard docs/dashboard-architecture.md docs/dashboard-threat-model.md docs/dashboard-test-plan.md
npm test
```

这只回退面板相关代码，不影响 `config/*.csv`（配置文件本身的格式在 M2 没有破坏性变更，M1 版本的面板可以继续读取 M2 阶段产生的配置文件）。CLI（`bin/run.js`）在整个过程中不受影响，一直可以独立运行。
