import Link from "next/link";

// Matches AdminSidebarBrand styling — large wordmark, left-aligned
// (X close button sits in the sidebar's top-right corner).
export default function StaffSidebarBrand() {
  return (
    <Link href="/staff" className="block">
      <div className="brand-wordmark text-white text-2xl leading-tight">IKIGAI OS</div>
      <div className="text-[10px] tracking-[2px] text-white/50 uppercase mt-1">
        Staff Portal
      </div>
    </Link>
  );
}
