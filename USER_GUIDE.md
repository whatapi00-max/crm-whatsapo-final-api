# WhatsApp CRM Pro — User Guide

> Simple guide for Admins and Marketers. Read only your section.

---

## Table of Contents

1. [What Is This?](#1-what-is-this)
2. [How to Access](#2-how-to-access)
3. [Admin Guide](#3-admin-guide)
4. [Marketer Guide](#4-marketer-guide)
5. [Common Issues](#5-common-issues)

---

## 1. What Is This?

WhatsApp CRM Pro is a tool that lets your marketing team:

- **Receive and reply** to WhatsApp messages from one dashboard
- **Manage leads** — track every contact through a sales pipeline
- **Blast messages** to lists of contacts
- **Schedule messages** to send automatically at a set time
- **Auto-reply** to keywords or new contacts
- **See analytics** — leads, revenue, message volume

Each marketer gets their own **WhatsApp number** connected via the official **WhatsApp Cloud API**. They only see their own leads and messages.

---

## 2. How to Access

The server must be **running** first. Ask your admin for the URL.

| Role | URL |
|------|-----|
| **Admin** | `https://your-domain.com/admin.html` |
| **Marketer** | `https://your-domain.com` |

**Supported browsers:** Chrome, Edge, Firefox

---

## 3. Admin Guide

### 3.1 Login

Go to `/admin.html` and log in with the admin credentials set in the `.env` file.

---

### 3.2 Dashboard Overview

The admin dashboard shows:
- **Total marketers** registered
- **Total leads** across all marketers
- **Messages today** (last 24 hours)
- A table of all marketer accounts with their WhatsApp API status

---

### 3.3 Creating a Marketer Account

1. Click **"+ Add Marketer"**
2. Fill in:
   - **Name** — display name (e.g. "Ahmad Sales")
   - **Username** — login username (e.g. `ahmad`)
   - **Password** — their login password
3. Click **Save**
4. Now configure their WhatsApp Cloud API.

---

### 3.4 Configuring WhatsApp Cloud API

Each marketer needs their own WhatsApp Cloud API credentials.

**Prerequisites:** A Meta Developer account with WhatsApp Business API access.

1. In the marketer row, click **"Configure API"**
2. Enter:
   - **Phone Number ID** — from Meta Developer Dashboard
   - **Access Token** — permanent or system user token
   - **WABA ID** — WhatsApp Business Account ID (optional)
3. Click **Save & Verify**
4. The system verifies the credentials against the Graph API
5. Status will change to **Connected** ✅

---

### 3.5 WhatsApp Status Indicators

| Status | Meaning |
|--------|---------|
| ✅ Connected | Cloud API configured and verified |
| 🔴 Not Configured | API credentials not set — click Configure API |

---

### 3.6 Disconnecting a Number

Click **"Disconnect"** to remove the Cloud API credentials from a marketer account.

---

### 3.7 Editing / Deleting a Marketer

- **Edit** — change name, username, or password
- **Delete** — permanently removes the marketer account and their data

---

### 3.8 Storage Management

Go to the **Storage** section in admin to:
- See how much database storage each marketer is using
- Run **Cleanup** to delete old messages (keeps last 30 days)
- Remove **orphaned records** with no matching lead

---

## 4. Marketer Guide

### 4.1 Login

Go to the URL your admin shared and log in with the username and password your admin created for you.

---

### 4.2 WhatsApp Connection

Before using the system, your WhatsApp Cloud API must be configured. Ask your admin to set it up from the admin panel. Once configured, you can start receiving and sending messages.

To check: look at the top-right corner of the screen — it shows your connection status.

---

### 4.3 Team Inbox (Main Chat Screen)

This is your main workspace — similar to WhatsApp Web.

**Left panel:** List of all your contacts sorted by latest message.
- 🔵 Blue dot = unread messages
- Color tags = lead status (New, Contacted, Interested, Sold)

**Right panel:** Chat window for the selected contact.

**To reply:**
1. Click any contact on the left
2. Type your message in the box at the bottom
3. Press **Enter** or click **Send**

**Quick Replies:** Click the ⚡ lightning bolt icon to insert a pre-saved message template.

---

### 4.4 Contacts (Lead Management)

View and manage all your leads in a table.

**Lead Statuses:**
| Status | Meaning |
|--------|---------|
| New | Just messaged you for the first time |
| Contacted | You've replied |
| Interested | They've shown buying interest |
| Sold | Deal closed |
| Lost | Didn't convert |

**To update a lead:**
- Click the status badge to change it
- Click the lead row to edit name, add revenue amount, add notes

**To delete a lead:** Click the trash icon (removes lead and all their messages)

**To import leads:** Use the **Import CSV** button. CSV must have a `phone` column.

---

### 4.5 Broadcasts (Blast Messages)

Send one message to many contacts at once.

**To create a broadcast:**
1. Go to **Broadcasts** in the sidebar
2. Click **"+ New Broadcast"**
3. Give it a name
4. Add phone numbers (paste a list or select from leads)
5. Write your message
6. Click **Save**, then **Send**

> Messages are sent with a delay between each one to stay within API rate limits.

---

### 4.6 Automation (Auto-Replies)

Set up automatic replies that trigger based on rules.

**Trigger types:**
| Type | What it does |
|------|-------------|
| First Message | Sends reply when someone messages you for the very first time |
| Keyword | Matches exact word (e.g. `price`) |
| Contains | Matches if message contains a word (e.g. `how much`) |
| Regex | Advanced pattern matching |

**To create an auto-reply:**
1. Go to **Automation**
2. Click **"+ Add Rule"**
3. Set trigger type and value
4. Write the reply message
5. Set priority (higher number = checked first)
6. Toggle **Active**

---

### 4.7 Scheduled Messages

Send a message to a contact at a specific future date and time.

1. Go to **Scheduled**
2. Click **"+ Schedule Message"**
3. Enter phone number, message, and date/time
4. Save

The system checks every 30 seconds and sends any due messages automatically.

---

### 4.8 Quick Replies

Pre-saved message templates for fast replies in chat.

1. Go to **Quick Replies**
2. Click **"+ Add"**
3. Give it a title (e.g. "Price List") and write the message
4. Save

In the chat inbox, click the ⚡ icon and select a template to insert instantly.

---

### 4.9 Analytics

View your performance:
- Total leads, contacted, interested, sold, lost
- Revenue from closed deals
- Messages sent today / this week
- Pipeline chart

---

### 4.10 Settings

- **Change your password**
- **Theme** — switch dark/light mode

---

## 5. Common Issues

### "My messages aren't sending"
- Check your WhatsApp status (top-right). If it shows Not Configured, ask your admin to set up the Cloud API.
- Check that your access token hasn't expired.

### "I'm not receiving new messages"
- The inbox refreshes automatically.
- Ensure the webhook is correctly configured in Meta Developer Dashboard.

### "The URL stopped working"
- The server might have been restarted. Ask your admin for the new URL.

---

*For technical issues, contact your system administrator.*
