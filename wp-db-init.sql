-- Mounted into /docker-entrypoint-initdb.d and executed once, when the wp-db
-- data volume is first initialized. The harness tears the volume down with
-- `docker compose down -v` (src/lib/docker.ts) between runs, so this is
-- re-applied on every run. An existing volume from before this file was added
-- will not have the `wordpress` account; `docker compose down -v` once to
-- recreate it.
--
-- The five WordPress containers used to connect as root with the root
-- password, which gave any plugin under test full control of the MariaDB
-- instance. They now share one unprivileged account whose grants stop at the
-- five sim databases. The mariadb entrypoint creates the account from
-- MYSQL_USER / MYSQL_PASSWORD before it runs this file; the grants below are
-- what scope it.

CREATE DATABASE IF NOT EXISTS wp1;
CREATE DATABASE IF NOT EXISTS wp2;
CREATE DATABASE IF NOT EXISTS wp3;
CREATE DATABASE IF NOT EXISTS wp4;
CREATE DATABASE IF NOT EXISTS wp5;

GRANT ALL PRIVILEGES ON `wp1`.* TO 'wordpress'@'%';
GRANT ALL PRIVILEGES ON `wp2`.* TO 'wordpress'@'%';
GRANT ALL PRIVILEGES ON `wp3`.* TO 'wordpress'@'%';
GRANT ALL PRIVILEGES ON `wp4`.* TO 'wordpress'@'%';
GRANT ALL PRIVILEGES ON `wp5`.* TO 'wordpress'@'%';

FLUSH PRIVILEGES;
