# Black Marble offline night-imagery pyramid

Earth at night, baked from NASA's Black Marble composite for use as the
bundled default night imagery layer. NASA imagery is in the public domain;
attribution is a courtesy, not a license condition:

> Image: NASA Earth Observatory / NOAA NGDC (Suomi NPP VIIRS Black Marble).

Provenance (reproducible bake):

- Source file: BlackMarble_2016_3km.jpg
- Source SHA-256: 230aac448ae68c358be433dd518888cccb3a85ccf66f7b44326441c324ad6725
- Source URL:
  <https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144898/BlackMarble_2016_3km.jpg>
- Bake: node Tools/bake-black-marble-pyramid.mjs
  (quality 80, maxLevel 3, sharp 0.34.5)

Layout mirrors ../NaturalEarthII: EPSG:4326 geodetic TMS, 256px JPEG tiles,
{z}/{x}/{y}.jpg with y=0 at the southern edge.
