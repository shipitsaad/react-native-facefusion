# react-native-facefusion

React Native TurboModule for on-device face swapping on Qualcomm Hexagon NPUs. Runs fully offline on the phone, no server and no uploads.

## Installation


```sh
npm install react-native-facefusion
```


## Usage


```js
import { swapPhoto } from 'react-native-facefusion';

const result = await swapPhoto(sourcePath, targetPath, outputPath);
```

A full API reference and the Android/Snapdragon requirements will land here in the
package's publish pass.

## Content gate

Every swap checks its target against upstream FaceFusion's NSFW content gate before
processing it, and refuses with `E_CONTENT` if it's flagged. This is not optional or
configurable from JS — a safeguard a caller can turn off is not a safeguard.

Known limits of this port, stated plainly rather than hidden:

- It gates on one model (`nsfw_2`) where upstream votes across three — the other two
  total 461 MB against this package's ~266 MB, and which way a single model errs
  against the full ensemble is unmeasured.
- On every chip tier except v79, the gate itself runs quantised, which measured
  ~0.087 mean closer to flagging than the full-precision model, 16 of 16 held-out
  frames in the same direction. Not compensated for — reported here instead.
- A still image is one check; a video samples one frame per second and refuses if
  more than 10% of samples are flagged.
- A failure to run the check (a native error, not a flagged result) is always treated
  as a refusal, never as "allow."

## Contributing

- [Development workflow](CONTRIBUTING.md#development-workflow)
- [Sending a pull request](CONTRIBUTING.md#sending-a-pull-request)
- [Code of conduct](CODE_OF_CONDUCT.md)

## License

MIT

---

Made with [create-react-native-library](https://github.com/callstack/react-native-builder-bob)
