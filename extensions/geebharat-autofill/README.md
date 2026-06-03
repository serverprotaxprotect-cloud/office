# GeeBharat Portal Autofill Extension

Internal unpacked Chrome extension for GeeBharat portal autofill.

Supported portals:
- GST: `https://services.gst.gov.in/services/login`
- Income Tax: `https://eportal.incometax.gov.in/iec/foservices/#/login`
- PF: `https://unifiedportal-emp.epfindia.gov.in/epfo/`
- ESIC: `https://www.esic.in/EmployerPortal/ESICInsurancePortal/Portal_Loginnew.aspx`

## Install

1. Download the ZIP from GeeBharat and extract it.
2. Open Chrome and go to `chrome://extensions`.
3. Enable `Developer mode`.
4. Click `Load unpacked`.
5. Select the extracted `geebharat-autofill` folder.

## Important

If old separate extensions are installed, remove or disable:
- GeeBharat GST Autofill
- GeeBharat Income Tax Autofill

Keep only `GeeBharat Portal Autofill` enabled to avoid duplicate actions.

## Use

GST:
1. Open GeeBharat Office.
2. Go to `GST Clients`.
3. Click `Login`.
4. GST ID/password autofill hoga. Captcha and final login manual rahega.

Income Tax:
1. Open GeeBharat Office.
2. Go to `Income Tax Clients`.
3. Click `Login`.
4. PAN/user ID, Continue, secure checkbox, password, and Continue flow automatic chalega.

PF / ESIC:
1. Open GeeBharat Office.
2. Go to `PF / ESIC Clients`.
3. Click `PF Login` or `ESIC Login`.
4. ID/password autofill hoga. Captcha/OTP/final login manual rahega.

The extension does not store credentials. Each token is one-time and short-lived.
