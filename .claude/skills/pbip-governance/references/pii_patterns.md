# PII Pattern Reference (DA/EN)

`parse_pbip.py` (and the browser fallback `assets/pbip-inspector.html`, which uses the same rules) flags column names as **potential** personal data with `pii_reason(column, table)`
(and `is_pii(column, table)`). Matches are heuristic: always review manually and say
"potential PII" or "PII candidate", never that a column IS PII.

## How matching works
1. The column name is split into words: snake_case, camelCase, spaces and hyphens
   (`CustomerEmail` → `customer`, `email`; `ip_address` → `ip`, `address`).
2. A column is flagged when a word, or two or three adjacent words joined
   (`first_name` → `firstname`, `date_of_birth` → `dateofbirth`), is in the word list below.
   Matching is on whole words, so `name` does not hit `product_name` and `ip` does not hit `shipping_date`.
3. Context rules use the table name:
   - `name`/`navn` counts only with a person word in the column (`customer_name`, `full_name`),
     or as a bare `name` in a person table (`dim_customer[name]`). It never counts next to a
     thing word (`product`, `campaign`, `month`, `city`, `company`, `category` …).
   - `city`/`town`/`by` counts only in a person table (`dim_customer[city]`, not `dim_region[city]`).
   - Role words that hold a person's name (`account_manager`, `salesperson`, `owner`, `ejer`) count
     unless combined with a thing word (`team_owner` does not count).
   - Person tables are recognised by words like customer/kunde, employee/medarbejder, user/bruger,
     person, contact/kontakt, patient, member/medlem, client/klient.

## Word list
| Group | Words |
|---|---|
| Contact | email, mail, phone, telephone, telefon, telefonnummer, tlf, mobil, mobile |
| National identifiers | cpr, cprnr, cprnummer, ssn, passport, pasnummer |
| Names and persons | firstname, lastname, fullname, middlename, surname, fornavn, efternavn, mellemnavn, username, brugernavn, contact, kontakt, kontaktperson |
| Addresses | address, adresse, street, gade, streetname, postnr, postnummer, zip, zipcode, postal, postalcode, postcode |
| Birth | dob, birth, birthdate, birthday, dateofbirth, fødsel, fødselsdato (also without ø) |
| Online identifiers | ip, ipaddress, deviceid, userid, brugerid |
| Financial | iban, accountnumber, kontonummer, kortnummer, cardnumber, creditcard, salary, løn, loen, income, indkomst |
| Special categories and similar | gender, sex, køn, koen, ethnic, ethnicity, religion, nationality, nationalitet, marital, maritalstatus, civilstand |

Removed compared with the earlier substring list, because they caused false positives:
`by` (inside words), `lon` (longitude), `kon`, `pas`, `account` (account_manager is caught as a role
instead), `cvr` and `vat` (company identifiers).

## Known limits
- Free-text columns (notes, comments) can contain personal data without a telling name.
- `country`, `region` and `credit_limit` are not flagged. In B2C data they can still identify a person in combination.
- `company_name` is not flagged; for sole proprietorships it can be personal data.
