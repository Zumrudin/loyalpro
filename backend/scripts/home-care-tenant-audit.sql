-- Read-only aggregate audit. No patient fields or identifiers are returned.
SELECT
  count(*) FILTER (WHERE p.client_id IS NOT NULL AND c.id IS NULL)::int AS bad_client_tenant,
  count(*) FILTER (WHERE p.record_id IS NOT NULL AND r.id IS NULL)::int AS bad_record_tenant,
  count(*) FILTER (WHERE p.specialist_id IS NOT NULL AND u.id IS NULL)::int AS bad_specialist_tenant,
  count(*) FILTER (WHERE p.client_id IS NOT NULL AND r.client_id IS NOT NULL
                    AND p.client_id <> r.client_id)::int AS bad_record_client
FROM home_care_prescriptions p
LEFT JOIN clients c ON c.id=p.client_id AND c.salon_id=p.salon_id
LEFT JOIN records r ON r.id=p.record_id AND r.salon_id=p.salon_id
LEFT JOIN users u ON u.id=p.specialist_id AND u.salon_id=p.salon_id;
