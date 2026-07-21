import { ImageResponse } from 'next/og';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

// Rendered to a PNG at request time — iOS uses this for the home-screen icon.
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#16a34a',
          color: '#ffffff',
          fontSize: 120,
          fontWeight: 700,
        }}
      >
        €
      </div>
    ),
    size,
  );
}
