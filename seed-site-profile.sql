-- Seeds the offline store-details mirror for site 4 (ODY-10003, "Tiaan VM").
-- Values copied from cp2_sites id=4 in the control database.
-- Run against ODY10003_master. Delete this file afterwards.

REPLACE INTO site_profile
  (id, site_id, site_code, company_name, trading_name, registration_number, vat_number,
   address1, address2, address3, postal_code, phone, email, contact_name,
   connection_type, site_type_id, is_paid, status, mirrored_at)
VALUES
  (1, 4, 'ODY-10003', 'Tiaan VM', 'Tiaan VM', NULL, '12345678901',
   NULL, NULL, NULL, NULL, NULL, NULL, NULL,
   'local', NULL, 0, 'active', NOW());

SELECT site_id, site_code, company_name, connection_type, mirrored_at FROM site_profile;
