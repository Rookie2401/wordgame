import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import QRCode from 'qrcode';

export function Flourish() {
  return (
    <svg className="flourish" viewBox="0 0 240 16" role="presentation" aria-hidden="true">
      <path d="M4 8h88M148 8h88" stroke="currentColor" strokeWidth="1" />
      <path d="M120 2l6 6-6 6-6-6z" fill="currentColor" />
      <circle cx="102" cy="8" r="1.6" fill="currentColor" />
      <circle cx="138" cy="8" r="1.6" fill="currentColor" />
    </svg>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'quiet';
  working?: boolean;
};

export function Button({ variant = 'primary', working, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={`btn btn-${variant}`}
      disabled={disabled || working}
      aria-busy={working || undefined}
      {...rest}
    >
      {working ? 'One moment…' : children}
    </button>
  );
}

export function Page({ children, label }: { children: ReactNode; label: string }) {
  return (
    <main className="page" aria-label={label}>
      {children}
    </main>
  );
}

interface DialogProps {
  open: boolean;
  onClose(): void;
  title: string;
  children: ReactNode;
}

export function Dialog({ open, onClose, title, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-label={title}
      onCancel={(e) => {
        // Escape / back gesture. Closing from code (open=false) must not count as a dismissal.
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose(); // tap on the backdrop
      }}
    >
      {open && (
        <div className="dialog-body">
          <h2 className="dialog-title">{title}</h2>
          {children}
        </div>
      )}
    </dialog>
  );
}

interface ConfirmProps {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm(): void;
  onCancel(): void;
}

export function Confirm({ open, title, body, confirmLabel, onConfirm, onCancel }: ConfirmProps) {
  return (
    <Dialog open={open} onClose={onCancel} title={title}>
      <p className="dialog-text">{body}</p>
      <div className="stack">
        <Button onClick={onConfirm}>{confirmLabel}</Button>
        <Button variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Dialog>
  );
}

export function QrCode({ url }: { url: string }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let alive = true;
    QRCode.toString(url, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#493522', light: '#FFFCF5' },
    }).then((s) => alive && setSvg(s));
    return () => {
      alive = false;
    };
  }, [url]);
  // The markup comes from the QR library, generated on this device from the URL.
  return (
    <div
      className="qr"
      role="img"
      aria-label="QR code that opens this game's invitation link"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' }) {
  return (
    <p className={`notice notice-${tone}`} role={tone === 'warn' ? 'alert' : 'status'}>
      {children}
    </p>
  );
}
