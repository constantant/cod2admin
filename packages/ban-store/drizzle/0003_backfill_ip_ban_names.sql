-- Names for IP bans made before ban_ips.name existed. A ban on a connected player left its name in
-- the audit log (target) next to its IP (detail_json.ip). A manual ban of a bare IP has the IP as
-- its target, so it stays nameless. audit_log belongs to admin-store, which the gateway migrates
-- first; anything else running only this package's migrations has no audit_log and no old bans.
DO $$
BEGIN
  IF to_regclass('audit_log') IS NOT NULL THEN
    UPDATE ban_ips AS ban
    SET name = (
      SELECT audit.target
      FROM audit_log AS audit
      WHERE audit.action IN ('ban', 'tempban')
        AND audit.detail_json ->> 'ip' = ban.ip
        AND audit.server_alias = ban.server_alias
        AND audit.actor_telegram_id = ban.banned_by
        AND audit.target IS NOT NULL
        AND audit.target <> ban.ip
        AND audit.created_at BETWEEN ban.banned_at - interval '1 minute'
                                 AND ban.banned_at + interval '1 minute'
      ORDER BY abs(extract(epoch FROM audit.created_at - ban.banned_at))
      LIMIT 1
    )
    WHERE ban.name IS NULL;
  END IF;
END $$;
