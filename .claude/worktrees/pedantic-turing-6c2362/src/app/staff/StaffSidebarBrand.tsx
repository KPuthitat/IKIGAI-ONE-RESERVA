import Link from "next/link";

export default function StaffSidebarBrand() {
  return (
    <Link href="/staff" className="block">
      <div className="brand-wordmark text-white text-lg leading-tight">IKIGAI OS</div>
      <div className="text-[10px] tracking-[2px] text-white/50 uppercase mt-0.5">
        Staff Portal
      </div>
    </Link>
  );
}
