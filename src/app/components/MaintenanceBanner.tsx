// Sticky banner at the top of every staff + admin page, shown when
// system_settings.maintenance_message is non-empty. Owner toggles it
// on right before a deploy so the team sees a calm "ระบบกำลังอัพเดท..."
// message and doesn't panic-reload when a request blips mid-deploy.
//
// Intentionally a SERVER component — no client state, no toggle UI
// here. The single source of truth is the DB column; admin flips it
// via /admin/system-settings → form POSTs → row updates → next page
// load sees (or doesn't see) the banner.
//
// Colour: blue (info), not red/orange — we want it to read as
// "everything's fine, just be patient" not "EMERGENCY". Red is
// already reserved for real auth-failure / system errors. Sticky so
// it stays visible while scrolling long forms.

export default function MaintenanceBanner({ message }: { message: string }) {
  return (
    <div className="sticky top-0 z-50 bg-sky-600 text-white shadow-md">
      <div className="max-w-7xl mx-auto px-3 py-2 flex items-center gap-3 text-xs sm:text-sm">
        <div className="flex-1 min-w-0 whitespace-pre-line">
          {message}
        </div>
      </div>
    </div>
  );
}
