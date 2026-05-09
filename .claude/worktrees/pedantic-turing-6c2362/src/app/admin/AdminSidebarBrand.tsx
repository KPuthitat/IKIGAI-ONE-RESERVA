import Link from "next/link";

// Static brand element shown at the top of the admin sidebar.
// (The page header / Topbar shows current module via HeaderBrand separately.)
export default function AdminSidebarBrand() {
  return (
    <Link href="/admin" className="block">
      <div className="brand-wordmark text-white text-lg leading-tight">IKIGAI OS</div>
      <div className="text-[10px] tracking-[2px] text-white/50 uppercase mt-0.5">
        Admin Console
      </div>
    </Link>
  );
}
