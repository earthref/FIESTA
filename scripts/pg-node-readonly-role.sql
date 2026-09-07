-- Grant a developer read-only access to ONE node's data.
--
--   psql "$FIESTA_DATABASE_URL" -v node=magic -v role=magic_dev -v password="'...'" \
--        -f scripts/pg-node-readonly-role.sql
--
-- Each node's workflow tables live in a schema named after the node; user
-- accounts live in the shared schema (public). The role sees the node schema
-- and the account columns needed to make sense of contributor_id, but never
-- password hashes or other nodes.
\set ON_ERROR_STOP on

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'role', :password) \gexec
GRANT CONNECT ON DATABASE fiesta TO :"role";

GRANT USAGE ON SCHEMA :"node" TO :"role";
GRANT SELECT ON ALL TABLES IN SCHEMA :"node" TO :"role";
ALTER DEFAULT PRIVILEGES IN SCHEMA :"node" GRANT SELECT ON TABLES TO :"role";

GRANT USAGE ON SCHEMA public TO :"role";
GRANT SELECT (id, email, name, handle, orcid, created_at) ON public.users TO :"role";

ALTER ROLE :"role" SET search_path = :"node", public;
