import Link from "next/link";

// Matches AdminSidebarBrand styling — larger centered wordmark.
export default function StaffSidebarBrand() {
  return (
    <Link href="/staff" className="block text-center">
      <div className="brand-wordmark text-white text-2xl leading-tight">IKIGAI OS</div>
      <div className="text-[10px] tracking-[2px] text-white/50 uppercase mt-1">
        Staff Portal
      </div>
    </Link>
  );
}
