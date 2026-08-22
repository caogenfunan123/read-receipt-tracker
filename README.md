# 📬 read-receipt-tracker (Vercel + Turso)

消息已读追踪服务，免费部署到公网。

## 部署步骤

### 1. 创建 Turso 数据库

1. 打开 https://turso.io
2. 用 GitHub 登录
3. 点 "Create Database"
4. 名字随便填，比如 `read-receipt-db`
5. 创建完成后，点 "Create Token" 生成认证令牌
6. 记下两个值：
   - **Database URL**: `libsql://xxx.turso.io`
   - **Auth Token**: `eyJ...`

### 2. 部署到 Vercel

1. 打开 https://vercel.com
2. 用 GitHub 登录
3. 点 "Add New..." → "Project"
4. 导入这个项目（或上传整个文件夹）
5. 在 "Environment Variables" 里添加：

| Key | Value |
|:---|:---|
| `TURSO_DB_URL` | 你的 Turso 数据库 URL |
| `TURSO_DB_AUTH_TOKEN` | 你的 Turso 认证令牌 |
| `API_KEY` | 随机字符串，比如 `abc123def456` |
| `ENABLE_GEO` | `1` |

6. 点 "Deploy"

### 3. 配置 WuYu

在 WuYu 模块设置里填：

```
服务器地址: https://你的项目名.vercel.app
API Key: 你设置的 API_KEY
```

## 管理面板

打开 `https://你的项目名.vercel.app`，密码是你设置的 API_KEY。

## API 接口

| 接口 | 方法 | 说明 |
|:---|:---|:---|
| `/health` | GET | 健康检查 |
| `/register` | POST | 注册消息 |
| `/pixel` | GET | 像素追踪 |
| `/count` | GET | 查询已读数 |
| `/api/messages` | GET | 消息列表 |
| `/api/reads/:id` | GET | 已读详情 |
| `/batch-status` | GET | 批量查询 |

## 本地开发

```bash
npm install
cp .env.example .env
# 编辑 .env 填入配置
npm run dev
```
