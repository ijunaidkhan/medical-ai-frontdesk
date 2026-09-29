#!/bin/sh
# Runs once, the first time the database volume is created.
#
# Creates the role the API uses at runtime. It is deliberately NOT the schema
# owner and is NOT a superuser, so PostgreSQL row-level security (tenant
# isolation) applies to it and it cannot alter tables or bypass policies.
# Table-level grants are added by the migrations, not here.
set -eu

psql -v ON_ERROR_STOP=1 \
     -v app_password="$DB_APP_PASSWORD" \
     -v dbname="$POSTGRES_DB" \
     --username "$POSTGRES_USER" \
     --dbname "$POSTGRES_DB" <<'EOSQL'
CREATE ROLE frontdesk_app
  LOGIN
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
  PASSWORD :'app_password';

GRANT CONNECT ON DATABASE :"dbname" TO frontdesk_app;
EOSQL
