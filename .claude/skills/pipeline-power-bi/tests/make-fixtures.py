"""Writes the test fixtures for pipeline-power-bi (run once; the files are committed).

    python make-fixtures.py

fixtures/orders.csv     semicolon, UTF-8 with BOM, Danish formats: title lines, mixed dates and amounts,
                        ja/nej spellings, id formats, case variants, spaces, a copy, an empty and a total
                        row, a future date, a negative amount, a channel code column, an empty note column,
                        an orphan customer id (K-009)
fixtures/customers.csv  comma, UTF-8: the customer list, with one TEST ACCOUNT row
fixtures/workbook.xlsx  sheets for the Excel and modelling checks (see the asserts in run-tests.js)
"""
import datetime as dt
import os

from openpyxl import Workbook
from openpyxl.worksheet.table import Table

here = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')
os.makedirs(here, exist_ok=True)

orders = [
    'Ordrerapport', 'Udtrukket 2026-01-31',
    'Ordrenr;Dato;KundeID;Region;Beløb;Betalt;Kanal;Note',
    '1001;03-01-2025;K-001;Nord;1.234,50;ja;10;',
    '1002;15-01-2025;K002;nord;99,95;nej;20;N/A',
    '1002;15-01-2025;K002;nord;99,95;nej;20;N/A',
    '1003;2025-01-20;K-003 ;Syd;-50,00;Ja;10;',
    '1004;31/01/2025;K-004;SYD;2.000,00;NEJ;30;',
    '1005;2025-02-01;K-009;Øst;300,00;ja;20;',
    '1006;2025-02-02;K-001;Øst;150,00;nej;10;',
    '1007;2025-02-03;K-002;Vest;75,25;ja;30;',
    '1008;2025-02-04;K-003;Vest;80,00;ja;20;',
    '1009;2025-02-05;K-004;Nord;60,00;nej;10;',
    '1010;2030-02-06;K-001;Syd;45,00;ja;30;',
    '1011;2025-02-07;K-002;Øst;55,00;ja;20;',
    ';;;;;;;',
    'I alt;;;;4.147,45;;;',
]
with open(os.path.join(here, 'orders.csv'), 'w', encoding='utf-8-sig', newline='') as f:
    f.write('\r\n'.join(orders) + '\r\n')

customers = ['KundeID,Navn,Segment', 'K-001,Alfa A/S,SMB', 'K-002,Beta ApS,Enterprise', 'K-003,Gamma,SMB',
             'K-004,Delta,Mid-Market', 'K-100,TEST ACCOUNT,SMB']
with open(os.path.join(here, 'customers.csv'), 'w', encoding='utf-8', newline='') as f:
    f.write('\n'.join(customers) + '\n')

wb = Workbook()
ws = wb.active
ws.title = 'Sales_2025'
hdr = ['OrderID', 'CustomerName', 'OrderDate', 'Amount']
ws.append(hdr)
for i in range(1, 7):
    ws.append([f'O-{i:03d}', f'Customer {i % 3}', dt.date(2025, i, 10), 100 * i])
ws2 = wb.create_sheet('Sales_2026')
ws2.append(hdr + ['Legacy'])
for i in range(1, 7):
    ws2.append([f'O-{100 + i:03d}', f'Customer {i % 3}', dt.date(2026, i, 10), 110 * i, None])
for row in ws.iter_rows(min_row=2, min_col=3, max_col=3):
    for c in row:
        c.number_format = 'yyyy-mm-dd'

p = wb.create_sheet('Products')
p.append(['ProductCode', 'ProductName', 'CategorySub'])
for code, name, cat in [('P-1', 'Apple', 'food|fruit'), ('P-2', 'Pear', 'food|fruit'), ('P-3', 'Bread', 'food|bakery'),
                        ('P-4', 'Soap', 'home|cleaning'), ('ZZZ-000', 'DO NOT USE', 'test|test')]:
    p.append([code, name, cat])
copy = wb.create_sheet('Sheet1')
for r in p.iter_rows(values_only=True):
    copy.append(list(r))

c = wb.create_sheet('Contacts')
c.append(['CustomerID', 'ContactName', 'Email', 'IsPrimary'])
for cid in (1, 2, 3):
    c.append([cid, f'Person {cid}a', f'p{cid}a@example.com', True])
    c.append([cid, f'Person {cid}b', f'p{cid}b@example.com', False])
c.add_table(Table(displayName='tblContacts', ref='A1:D7'))

camp = wb.create_sheet('Campaigns')
camp.append(['CampaignName', 'Channel', 'Budget', 'Date', 'Clicks'])
for name, ch, budget in [('Spring', 'Social', 5000), ('Summer', 'Search', 8000), ('Autumn', 'Social', 3000)]:
    for d in range(8):
        camp.append([name, ch, budget, dt.date(2025, 3, 1 + d), 10 + d])

promo = wb.create_sheet('Promo')
promo.append(['CampaignName', 'SKUs'])
promo.append(['Spring', 'P-1, P-2, P-3'])
promo.append(['Summer', 'P-2, P-4, P-3'])
promo.append(['Autumn', 'P-1, P-4, P-2'])

notes = wb.create_sheet('Notes')
notes['A1'] = 'internal'
notes.sheet_state = 'hidden'
wb.create_sheet('Empty')
wb.save(os.path.join(here, 'workbook.xlsx'))
print('fixtures written to', here)
