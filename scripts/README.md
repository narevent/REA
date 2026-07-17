# REA deployment scripts

Bash scripts for deploying and maintaining the REA (Relative Ear-training)
Django app on a fresh Debian 13 VPS, with code shipped from GitHub and the
**large exercise data kept off GitHub** in a persistent on-server directory.

## What lives where

| Path on server         | Purpose                                              | In git? |
|------------------------|------------------------------------------------------|---------|
| `/opt/rea5`            | Git checkout — the app code                          | yes     |
| `/opt/rea5/.venv`      | Python virtualenv                                    | no      |
| `/opt/rea-data`        | Persistent data: `relative/`, `absolute/`, `db.sqlite3` | no  |
| `/opt/rea-backups`     | Backups produced by `backup.sh`                      | no      |
| `/opt/rea5/.env`       | Secret key + settings (generated)                    | no      |

The `relative/`, `absolute/` directories and `rea/db.sqlite3` are **symlinked**
from `/opt/rea-data` into the checkout, so `git pull` / `update.sh` can freely
overwrite the repo without ever touching the database or the JSON exercise
libraries. They are ignored by `.gitignore` and never committed.

## Scripts

| Script         | When to run            | What it does |
|----------------|------------------------|--------------|
| `init_vps.sh`  | **once**, as root      | Installs deps, creates service user, clones repo, builds venv, writes `.env`, sets up Gunicorn + Nginx, opens the firewall |
| `deploy.sh`    | after init / big changes | Pulls code, installs deps, migrates, collects static, **imports all JSON data**, restarts services |
| `update.sh`    | after each `git push`  | Pulls code, reinstalls deps only if `requirements.txt` changed, migrates, collects static, restarts (no re-import) |
| `backup.sh`    | cron / manually        | Tarballs the DB + both JSON data dirs + `.env` into `/opt/rea-backups`, rotates old copies |
| `restore.sh`   | disaster recovery      | Stops the app, restores a backup tarball, re-links, restarts |
| `config.sh`    | sourced by all of the above | Centralised, overridable settings |

## First-time setup

1. Push your code to GitHub (make sure `relative/`, `absolute/`, `rea/db.sqlite3`
   and `rea/static/` are **not** committed — `.gitignore` already excludes them).
2. On the fresh Debian 13 VPS, as root:

   ```bash
   apt-get update && apt-get install -y git
   git clone https://github.com/you/rea5.git /tmp/rea5
   cd /tmp/rea5
   sudo REA_REPO_URL=https://github.com/you/rea5.git \
        REA_DOMAIN=rea.example.com \
        bash scripts/init_vps.sh
   ```

3. Copy your exercise JSON onto the server into the persistent data dir:

   ```bash
   # from your local machine
   rsync -av relative/ root@vps:/opt/rea-data/relative/
   rsync -av absolute/ root@vps:/opt/rea-data/absolute/
   # optionally ship an existing database
   scp rea/db.sqlite3 root@vps:/opt/rea-data/db.sqlite3
   ```

4. Deploy:

   ```bash
   sudo bash /opt/rea5/scripts/deploy.sh
   ```

5. (recommended) HTTPS via Let's Encrypt:

   ```bash
   apt-get install -y certbot python3-certbot-nginx
   certbot --nginx -d rea.example.com
   ```

## Routine updates

After pushing to `main` on GitHub:

```bash
sudo bash /opt/rea5/scripts/update.sh
```

## Backups

```bash
sudo bash /opt/rea5/scripts/backup.sh                       # latest kept, rotation = 14
sudo KEEP=30 bash /opt/rea5/scripts/backup.sh               # keep 30
sudo bash /opt/rea5/scripts/restore.sh                      # restore latest
sudo bash /opt/rea5/scripts/restore.sh /opt/rea-backups/rea-backup-20260717T120000Z.tar.gz
```

A recommended cron entry (root's crontab — `sudo crontab -e`):

```cron
# daily 3am backup
0 3 * * * /opt/rea5/scripts/backup.sh >> /opt/rea5/rea/logs/backup.log 2>&1
```

## Configuration overrides

Every variable in `config.sh` can be overridden via the environment when you
invoke a script. The commonly-set ones:

| Variable        | Default                  | Notes |
|-----------------|--------------------------|-------|
| `REA_REPO_URL`  | *(required)*             | HTTPS URL recommended for init |
| `REA_DOMAIN`    | `localhost`              | Nginx `server_name` |
| `REA_BRANCH`    | `main`                   | branch/tag tracked by update.sh |
| `APP_ROOT`      | `/opt/rea5`              | git checkout path |
| `DATA_ROOT`     | `/opt/rea-data`          | persistent data path |
| `BACKUP_DIR`    | `/opt/rea-backups`       | backup destination |
| `REA_PORT`      | `8000`                   | gunicorn bind port |
| `GUNICORN_WORKERS` | `3`                   | gunicorn worker count |
| `KEEP`          | `14`                     | backup retention count |
| `SERVICE_USER`  | `rea`                    | system user running the app |