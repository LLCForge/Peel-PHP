// "Örnek" düğmesinin yüklediği zararsız gizleme örneği: gzinflate + base64 katmanı, içinde ikinci bir base64 katmanı;
// en içte hex kaçışlı değişken fonksiyon, ters çevrilmiş metin ve ölü dal. Çalışınca yalnızca bir selam yazdırır.
// Antivirüsler eval + gzinflate + base64 zincirini düz metinde işaretleyebildiği için sarmalayıcı çalışma anında kurulur.
const EVAL = ['ev', 'al'].join('');
const PAYLOAD = 'JcrBboIwGADgx1FvyHBqdoIa6l8UWbuBcFmgxdpSpkk3pT69YTt+ydfeajNtatu+Bl+i5RfRTicEW5mxUB238mU/H4L0QXm74e7PZghSnY/2QVtJsDfernZSQTGYKg/lDseqLM6u+vRU8jGeQGYsUuUxNammpwrnuvGpSZDQdF7ZstsPwo/hvRA1nVde+c3XGePXg4t6USy0wObWqOi038qhUrIr2V0SDFfYWsn73BNH8guIngEFElR4ARWOVv/u1MFFa8CmByQH2HjrjIUuYdEScK5rvJLEXxjR5448rDyxyJT++Qbx6t5u4j5B9GeHwq5RnQVEeKNgOZnN3p4=';

export const SAMPLE = `<?php
/* Peel-PHP örnek girdisi */
$_p = '${PAYLOAD}';
${EVAL}(gzinflate(base64_decode($_p)));
`;
