import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Živý hľadáčik zadnej kamery.
 *
 * Rozlíšenie sa pýta na 4K zámerne. Snímka z hľadáčika je len rámik videa,
 * takže pri predvolených 1280×720 by na bločku zmizlo drobné písmo — a celý
 * zmysel je, aby to AI prečítala. Prehliadač dá, čo vie; na iPhone to býva
 * 4K, inde 1080p, a zmenšenie na 2000 px si to zoberie odtiaľ.
 *
 * Keď sa stream nedá otvoriť (odmietnuté povolenie, nepodporovaný prehliadač,
 * http), vráti sa `nedostupna` a obrazovka prepne na systémovú kameru cez
 * input capture. Bez toho by na takom telefóne nešlo odfotiť vôbec nič.
 *
 * ponytail: blesk sa ponúka len tam, kde ho prehliadač priznáva
 *   (getCapabilities().torch). Safari na iOS ho neovláda vôbec, takže tam
 *   tlačidlo nie je — mŕtve tlačidlo je horšie než žiadne.
 */
export interface StavKamery {
  video: React.RefObject<HTMLVideoElement>;
  bezi: boolean;
  nedostupna: boolean;
  maBlesk: boolean;
  blesk: boolean;
  prepniBlesk: () => void;
  /** Odfotí aktuálny rámik v natívnom rozlíšení streamu. */
  odfot: () => Promise<Blob>;
}

export function useKamera(aktivna: boolean): StavKamery {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream>();
  const [bezi, setBezi] = useState(false);
  const [nedostupna, setNedostupna] = useState(false);
  const [maBlesk, setMaBlesk] = useState(false);
  const [blesk, setBlesk] = useState(false);

  useEffect(() => {
    let zrusene = false;
    if (!aktivna) return undefined;

    const zapni = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setNedostupna(true);
        return;
      }
      try {
        const media = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 3840 },
            height: { ideal: 2160 },
          },
          audio: false,
        });
        if (zrusene) {
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        stream.current = media;
        if (video.current) {
          video.current.srcObject = media;
          await video.current.play().catch(() => undefined);
        }
        const track = media.getVideoTracks()[0];
        const schopnosti = (track?.getCapabilities?.() ?? {}) as { torch?: boolean };
        setMaBlesk(Boolean(schopnosti.torch));
        setBezi(true);
        setNedostupna(false);
      } catch {
        if (!zrusene) setNedostupna(true);
      }
    };
    void zapni();

    return () => {
      zrusene = true;
      stream.current?.getTracks().forEach((track) => track.stop());
      stream.current = undefined;
      setBezi(false);
      setBlesk(false);
    };
  }, [aktivna]);

  const prepniBlesk = useCallback(() => {
    const track = stream.current?.getVideoTracks()[0];
    if (!track) return;
    const dalsi = !blesk;
    // Typy DOM torch nepoznajú; podporu sme si overili cez getCapabilities.
    void track.applyConstraints({ advanced: [{ torch: dalsi }] } as never)
      .then(() => setBlesk(dalsi))
      .catch(() => setMaBlesk(false));
  }, [blesk]);

  const odfot = useCallback(async () => {
    const prvok = video.current;
    if (!prvok || !prvok.videoWidth) throw new Error('kamera_nepripravena');
    const platno = document.createElement('canvas');
    platno.width = prvok.videoWidth;
    platno.height = prvok.videoHeight;
    const kontext = platno.getContext('2d');
    if (!kontext) throw new Error('canvas_nedostupny');
    kontext.drawImage(prvok, 0, 0);
    const blob = await new Promise<Blob | null>((hotovo) =>
      platno.toBlob(hotovo, 'image/jpeg', 0.92));
    if (!blob) throw new Error('canvas_nedostupny');
    return blob;
  }, []);

  return { video, bezi, nedostupna, maBlesk, blesk, prepniBlesk, odfot };
}
