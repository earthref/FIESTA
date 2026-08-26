import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cx } from "../../lib/utils";

export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-x-auto">
      <table className={cx("w-full border-collapse text-left text-sm", className)} {...props} />
    </div>
  );
}

export function THead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cx("bg-gray-50", className)} {...props} />;
}

export function TBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cx("divide-y divide-gray-100", className)} {...props} />;
}

export function Tr({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cx("hover:bg-gray-50/60", className)} {...props} />;
}

export function Th({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cx(
        "whitespace-nowrap px-3 py-2 text-xs font-semibold uppercase tracking-wide text-gray-600",
        className,
      )}
      {...props}
    />
  );
}

export function Td({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cx("px-3 py-2 align-top text-gray-800", className)} {...props} />;
}
